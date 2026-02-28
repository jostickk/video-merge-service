const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const cors = require('cors');

const app = express();
const execPromise = util.promisify(exec);

// ✅ ИСПРАВЛЕНО: Настройка multer с сохранением оригинальных имен
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    // Генерируем уникальное имя, но сохраняем расширение
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB лимит
});

app.use(cors());
app.use(express.json());

// Создаём папки
const dirs = ['uploads', 'output'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// Эндпоинт для объединения видео
app.post('/merge-video', upload.array('videos', 10), async (req, res) => {
  const timestamp = Date.now();
  
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Нет файлов' });
    }
    
    console.log(`📁 Получено ${files.length} файлов:`);
    files.forEach((f, i) => {
      console.log(`  ${i+1}. ${f.originalname} (${f.mimetype})`);
    });
    
    // ✅ ИСПРАВЛЕНО: Правильное создание списка файлов для FFmpeg
    const listPath = path.join(__dirname, 'uploads', `list_${timestamp}.txt`);
    let fileList = '';
    
    // Определяем, есть ли аудиофайлы
    const hasAudio = files.some(f => f.mimetype.startsWith('audio/'));
    const hasVideo = files.some(f => f.mimetype.startsWith('video/'));
    
    for (let i = 0; i < files.length; i++) {
      // ✅ ИСПРАВЛЕНО: Используем правильный путь к файлу
      // files[i].path уже содержит полный путь, но FFmpeg может не найти его,
      // если рабочая директория не совпадает. Используем абсолютный путь.
      const absolutePath = path.resolve(files[i].path);
      
      // Для Windows нужно экранировать обратные слеши
      const safePath = absolutePath.replace(/\\/g, '/');
      
      fileList += `file '${safePath}'\n`;
      
      console.log(`  Добавлен в список: ${safePath}`);
    }
    
    fs.writeFileSync(listPath, fileList);
    console.log(`📝 Список файлов сохранён: ${listPath}`);
    
    // Выходной файл
    const outputPath = path.join(__dirname, 'output', `merged_${timestamp}.mp4`);
    
    // ✅ ИСПРАВЛЕНО: Умная команда FFmpeg в зависимости от типов файлов
    let ffmpegCommand;
    
    if (files.length === 2 && hasVideo && hasAudio) {
      // Случай: одно видео + одно аудио - накладываем аудио на видео
      const videoFile = files.find(f => f.mimetype.startsWith('video/'));
      const audioFile = files.find(f => f.mimetype.startsWith('audio/'));
      
      const videoPath = path.resolve(videoFile.path).replace(/\\/g, '/');
      const audioPath = path.resolve(audioFile.path).replace(/\\/g, '/');
      
      ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y "${outputPath}"`;
      console.log('🎬 Режим: наложение аудио на видео');
    } else {
      // Случай: несколько видео - конкатенация
      ffmpegCommand = `ffmpeg -f concat -safe 0 -i "${listPath}" -c copy -y "${outputPath}"`;
      console.log('🎬 Режим: объединение видео');
    }
    
    console.log(`🚀 Запуск FFmpeg: ${ffmpegCommand}`);
    
    try {
      await execPromise(ffmpegCommand);
      console.log('✅ FFmpeg успешно завершил работу');
    } catch (e) {
      console.log('⚠️ Первая попытка не удалась, пробуем с перекодированием...');
      
      if (files.length === 2 && hasVideo && hasAudio) {
        // Fallback для видео+аудио
        const videoFile = files.find(f => f.mimetype.startsWith('video/'));
        const audioFile = files.find(f => f.mimetype.startsWith('audio/'));
        
        const videoPath = path.resolve(videoFile.path).replace(/\\/g, '/');
        const audioPath = path.resolve(audioFile.path).replace(/\\/g, '/');
        
        const fallbackCommand = `ffmpeg -i "${videoPath}" -i "${audioPath}" -c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y "${outputPath}"`;
        await execPromise(fallbackCommand);
      } else {
        // Fallback для конкатенации видео
        const fallbackCommand = `ffmpeg -f concat -safe 0 -i "${listPath}" -c:v libx264 -c:a aac -y "${outputPath}"`;
        await execPromise(fallbackCommand);
      }
      console.log('✅ FFmpeg успешно завершил работу со второй попытки');
    }
    
    // Проверяем, создался ли файл
    if (!fs.existsSync(outputPath)) {
      throw new Error('Выходной файл не создан');
    }
    
    console.log(`📤 Отправка файла: ${outputPath}`);
    
    // Отправляем файл обратно
    res.sendFile(outputPath, {}, (err) => {
      if (err) {
        console.error('❌ Ошибка отправки:', err);
      } else {
        console.log('✅ Файл успешно отправлен');
      }
      
      // Чистим за собой (асинхронно, чтобы не блокировать ответ)
      setTimeout(() => {
        try {
          if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
          files.forEach(f => {
            if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
          });
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          console.log('🧹 Временные файлы очищены');
        } catch (cleanErr) {
          console.error('Ошибка при очистке:', cleanErr);
        }
      }, 1000);
    });
    
  } catch (error) {
    console.error('❌ Ошибка:', error);
    res.status(500).json({ error: error.message });
  }
});

// Эндпоинт для проверки с информацией
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Video Merge Service',
    version: '2.0',
    endpoints: {
      merge: '/merge-video (POST)',
      health: '/health (GET)'
    }
  });
});

// Эндпоинт для информации о форматах
app.get('/info', (req, res) => {
  res.json({
    message: 'Отправьте POST запрос на /merge-video с полем "videos" (multipart/form-data)',
    supported: {
      video: ['mp4', 'mov', 'avi', 'mkv'],
      audio: ['mp3', 'm4a', 'wav', 'aac', 'mpga']
    },
    modes: [
      '1 видео + 1 аудио → наложение аудио на видео',
      '2+ видео → объединение видео'
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Video Merge Service запущен на порту ${PORT}`);
  console.log(`📝 Endpoints:`);
  console.log(`   POST /merge-video - объединение видео/аудио`);
  console.log(`   GET  /health - проверка статуса`);
  console.log(`   GET  /info - информация о сервисе`);
});
