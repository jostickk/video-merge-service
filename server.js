
```javascript
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const cors = require('cors');
const FormData = require('form-data');
const fetch = require('node-fetch');

const app = express();
const execPromise = util.promisify(exec);

// ✅ Настройка multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());

// ✅ Создаём папки
['uploads', 'output', 'subtitles'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// ✅ Генерация субтитров через Whisper
async function generateSubtitles(audioPath, outputSrtPath, openaiKey) {
  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioPath));
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'srt');
    formData.append('language', 'en');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Whisper API error: ${response.statusText}`);
    }

    const srtContent = await response.text();
    fs.writeFileSync(outputSrtPath, srtContent);
    console.log('✅ Субтитры сгенерированы');
    return true;
  } catch (err) {
    console.error('❌ Ошибка генерации субтитров:', err.message);
    return false;
  }
}

// ✅ Главный эндпоинт
app.post('/merge-video', upload.fields([
  { name: 'videos', maxCount: 15 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  const timestamp = Date.now();

  try {
    const videoFiles = req.files['videos'] || [];
    const audioFiles = req.files['audio'] || [];

    if (videoFiles.length === 0) {
      return res.status(400).json({ error: 'Нет видео файлов' });
    }

    const openaiKey = req.body.openai_key || process.env.OPENAI_API_KEY;
    const watermarkText = req.body.watermark || '@aieye21';
    const addSubtitles = req.body.subtitles !== 'false';

    console.log(`📁 Видео файлов: ${videoFiles.length}`);
    console.log(`🎵 Аудио файлов: ${audioFiles.length}`);
    console.log(`💧 Watermark: ${watermarkText}`);
    console.log(`📝 Субтитры: ${addSubtitles}`);

    // ШАГ 1 — Склейка всех видео
    const listPath = path.join(__dirname, 'uploads', `list_${timestamp}.txt`);
    let fileList = '';

    for (const file of videoFiles) {
      const absolutePath = path.resolve(file.path).replace(/\\/g, '/');
      fileList += `file '${absolutePath}'\n`;
    }

    fs.writeFileSync(listPath, fileList);

    const concatenatedPath = path.join(__dirname, 'output', `concat_${timestamp}.mp4`);

    console.log('🎬 Склейка видео...');
    try {
      await execPromise(`ffmpeg -f concat -safe 0 -i "${listPath}" -c copy -y "${concatenatedPath}"`);
    } catch (e) {
      await execPromise(`ffmpeg -f concat -safe 0 -i "${listPath}" -c:v libx264 -c:a aac -y "${concatenatedPath}"`);
    }
    console.log('✅ Видео склеено');

    // ШАГ 2 — Наложение аудио
    let videoWithAudioPath = concatenatedPath;

    if (audioFiles.length > 0) {
      const audioPath = path.resolve(audioFiles[0].path).replace(/\\/g, '/');
      videoWithAudioPath = path.join(__dirname, 'output', `with_audio_${timestamp}.mp4`);

      console.log('🎵 Наложение аудио...');
      try {
        await execPromise(
          `ffmpeg -i "${concatenatedPath}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y "${videoWithAudioPath}"`
        );
      } catch (e) {
        await execPromise(
          `ffmpeg -i "${concatenatedPath}" -i "${audioPath}" -c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y "${videoWithAudioPath}"`
        );
      }
      console.log('✅ Аудио наложено');
    }

    // ШАГ 3 — Субтитры
    let videoWithSubtitlesPath = videoWithAudioPath;

    if (addSubtitles && audioFiles.length > 0 && openaiKey) {
      const audioPath = path.resolve(audioFiles[0].path).replace(/\\/g, '/');
      const srtPath = path.join(__dirname, 'subtitles', `subs_${timestamp}.srt`);

      console.log('📝 Генерация субтитров...');
      const subsGenerated = await generateSubtitles(audioPath, srtPath, openaiKey);

      if (subsGenerated) {
        videoWithSubtitlesPath = path.join(__dirname, 'output', `with_subs_${timestamp}.mp4`);
        const safeSrtPath = srtPath.replace(/\\/g, '/').replace(/'/g, "\\'");

        try {
          await execPromise(
            `ffmpeg -i "${videoWithAudioPath}" -vf "subtitles='${safeSrtPath}':force_style='FontName=Arial,FontSize=14,PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=2,Alignment=2'" -c:a copy -y "${videoWithSubtitlesPath}"`
          );
          console.log('✅ Субтитры добавлены');
        } catch (e) {
          console.log('⚠️ Субтитры не добавились, продолжаем без них');
          videoWithSubtitlesPath = videoWithAudioPath;
        }
      }
    }

    // ШАГ 4 — Watermark
    const outputPath = path.join(__dirname, 'output', `final_${timestamp}.mp4`);

    console.log('💧 Добавление watermark...');
    try {
      await execPromise(
        `ffmpeg -i "${videoWithSubtitlesPath}" -vf "drawtext=text='${watermarkText}':fontcolor=white:fontsize=24:x=w-tw-20:y=20:shadowcolor=black:shadowx=2:shadowy=2:font='Arial'" -c:a copy -y "${outputPath}"`
      );
      console.log('✅ Watermark добавлен');
    } catch (e) {
      console.log('⚠️ Watermark не добавился, сохраняем без него');
      fs.copyFileSync(videoWithSubtitlesPath, outputPath);
    }

    // ШАГ 5 — Отправка файла
    if (!fs.existsSync(outputPath)) {
      throw new Error('Выходной файл не создан');
    }

    const stats = fs.statSync(outputPath);
    console.log(`📤 Отправка файла: ${outputPath} (${Math.round(stats.size / 1024 / 1024)}MB)`);

    res.sendFile(path.resolve(outputPath), {}, (err) => {
      if (err) {
        console.error('❌ Ошибка отправки:', err);
      } else {
        console.log('✅ Файл успешно отправлен');
      }

      // Чистка временных файлов
      setTimeout(() => {
        try {
          const filesToDelete = [
            listPath,
            concatenatedPath,
            videoWithAudioPath,
            videoWithSubtitlesPath,
            outputPath,
            ...videoFiles.map(f => f.path),
            ...audioFiles.map(f => f.path)
          ];

          filesToDelete.forEach(f => {
            if (f && fs.existsSync(f)) fs.unlinkSync(f);
          });

          // Чистка субтитров
          const srtPath = path.join(__dirname, 'subtitles', `subs_${timestamp}.srt`);
          if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath);

          console.log('🧹 Временные файлы очищены');
        } catch (cleanErr) {
          console.error('Ошибка при очистке:', cleanErr);
        }
      }, 2000);
    });

  } catch (error) {
    console.error('❌ Ошибка:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Video Merge Service',
    version: '3.0',
    features: ['concat', 'audio', 'subtitles', 'watermark'],
    endpoints: {
      merge: '/merge-video (POST)',
      health: '/health (GET)',
      info: '/info (GET)'
    }
  });
});

// ✅ Info
app.get('/info', (req, res) => {
  res.json({
    message: 'POST /merge-video с полями videos[] и audio',
    fields: {
      videos: 'Массив видео файлов (mp4)',
      audio: 'Аудио файл (mp3/m4a)',
      openai_key: 'OpenAI API ключ для субтитров',
      watermark: 'Текст watermark (по умолчанию @aieye21)',
      subtitles: 'true/false (по умолчанию true)'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Video Merge Service v3.0 запущен на порту ${PORT}`);
  console.log(`📝 Endpoints:`);
  console.log(`   POST /merge-video - merge + subtitles + watermark`);
  console.log(`   GET  /health - статус`);
  console.log(`   GET  /info - информация`);
});
```
