const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const cors = require('cors');

const app = express();
const execPromise = util.promisify(exec);

// Настройка для приёма файлов
const upload = multer({ dest: 'uploads/' });

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
      return res.status(400).json({ error: 'Нет видео' });
    }
    
    console.log(`Получено ${files.length} видео`);
    
    // Создаём список файлов для FFmpeg
    const listPath = path.join(__dirname, 'uploads', `list_${timestamp}.txt`);
    let fileList = '';
    
    for (let i = 0; i < files.length; i++) {
      fileList += `file '${files[i].path}'\n`;
    }
    
    fs.writeFileSync(listPath, fileList);
    
    // Выходной файл
    const outputPath = path.join(__dirname, 'output', `merged_${timestamp}.mp4`);
    
    // Запускаем FFmpeg
    const ffmpegCommand = `ffmpeg -f concat -safe 0 -i "${listPath}" -c copy -y "${outputPath}"`;
    
    try {
      await execPromise(ffmpegCommand);
    } catch (e) {
      // Если не получилось, пробуем с перекодированием
      const fallbackCommand = `ffmpeg -f concat -safe 0 -i "${listPath}" -c:v libx264 -c:a aac -y "${outputPath}"`;
      await execPromise(fallbackCommand);
    }
    
    // Отправляем файл обратно
    res.sendFile(outputPath, {}, (err) => {
      if (err) console.error('Ошибка отправки:', err);
      
      // Чистим за собой
      try {
        fs.unlinkSync(listPath);
        files.forEach(f => fs.unlinkSync(f.path));
        fs.unlinkSync(outputPath);
      } catch (cleanErr) {}
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Проверка работы
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});