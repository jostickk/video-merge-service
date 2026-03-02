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

['uploads', 'output', 'subtitles'].forEach(function(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

async function generateSubtitles(audioPath, outputSrtPath, openaiKey) {
  try {
    var formData = new FormData();
    formData.append('file', fs.createReadStream(audioPath));
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'srt');
    formData.append('language', 'en');

    var headers = formData.getHeaders();
    headers['Authorization'] = 'Bearer ' + openaiKey;

    var response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: headers,
      body: formData
    });

    if (!response.ok) {
      throw new Error('Whisper API error: ' + response.statusText);
    }

    var srtContent = await response.text();
    fs.writeFileSync(outputSrtPath, srtContent);
    console.log('Subtitles generated successfully');
    return true;
  } catch (err) {
    console.error('Subtitles generation error:', err.message);
    return false;
  }
}

app.post('/merge-video', upload.fields([
  { name: 'videos', maxCount: 15 },
  { name: 'audio', maxCount: 1 }
]), async function(req, res) {
  var timestamp = Date.now();

  try {
    var videoFiles = req.files['videos'] || [];
    var audioFiles = req.files['audio'] || [];

    if (videoFiles.length === 0) {
      return res.status(400).json({ error: 'No video files provided' });
    }

    var openaiKey = req.body.openai_key || process.env.OPENAI_API_KEY || '';
    var watermarkText = req.body.watermark || '@aieye21';
    var addSubtitles = req.body.subtitles !== 'false';

    console.log('Video files: ' + videoFiles.length);
    console.log('Audio files: ' + audioFiles.length);
    console.log('Watermark: ' + watermarkText);
    console.log('Subtitles: ' + addSubtitles);

    var listPath = path.join(__dirname, 'uploads', 'list_' + timestamp + '.txt');
    var fileList = '';

    for (var i = 0; i < videoFiles.length; i++) {
      var absolutePath = path.resolve(videoFiles[i].path).replace(/\\/g, '/');
      fileList += "file '" + absolutePath + "'\n";
    }

    fs.writeFileSync(listPath, fileList);

    var concatenatedPath = path.join(__dirname, 'output', 'concat_' + timestamp + '.mp4');

    console.log('Concatenating videos...');
    try {
      await execPromise('ffmpeg -f concat -safe 0 -i "' + listPath + '" -c copy -y "' + concatenatedPath + '"');
    } catch (e) {
      await execPromise('ffmpeg -f concat -safe 0 -i "' + listPath + '" -c:v libx264 -c:a aac -y "' + concatenatedPath + '"');
    }
    console.log('Videos concatenated');

    var videoWithAudioPath = concatenatedPath;

    if (audioFiles.length > 0) {
      var audioPath = path.resolve(audioFiles[0].path).replace(/\\/g, '/');
      videoWithAudioPath = path.join(__dirname, 'output', 'with_audio_' + timestamp + '.mp4');

      console.log('Adding audio...');
      try {
        await execPromise(
          'ffmpeg -i "' + concatenatedPath + '" -i "' + audioPath + '" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y "' + videoWithAudioPath + '"'
        );
      } catch (e) {
        await execPromise(
          'ffmpeg -i "' + concatenatedPath + '" -i "' + audioPath + '" -c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y "' + videoWithAudioPath + '"'
        );
      }
      console.log('Audio added');
    }

    var videoWithSubtitlesPath = videoWithAudioPath;

    if (addSubtitles && audioFiles.length > 0 && openaiKey) {
      var audioPathForSubs = path.resolve(audioFiles[0].path).replace(/\\/g, '/');
      var srtPath = path.join(__dirname, 'subtitles', 'subs_' + timestamp + '.srt');

      console.log('Generating subtitles...');
      var subsGenerated = await generateSubtitles(audioPathForSubs, srtPath, openaiKey);

      if (subsGenerated) {
        videoWithSubtitlesPath = path.join(__dirname, 'output', 'with_subs_' + timestamp + '.mp4');
        var safeSrtPath = srtPath.replace(/\\/g, '/');

        try {
          await execPromise(
            'ffmpeg -i "' + videoWithAudioPath + '" -vf "subtitles=' + "'" + safeSrtPath + "'" + ':force_style=' + "'FontName=Arial,FontSize=14,PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=2,Alignment=2'" + '" -c:a copy -y "' + videoWithSubtitlesPath + '"'
          );
          console.log('Subtitles added');
        } catch (e) {
          console.log('Subtitles failed, continuing without them');
          videoWithSubtitlesPath = videoWithAudioPath;
        }
      }
    }

    var outputPath = path.join(__dirname, 'output', 'final_' + timestamp + '.mp4');

    console.log('Adding watermark...');
    try {
      await execPromise(
        'ffmpeg -i "' + videoWithSubtitlesPath + '" -vf "drawtext=text=' + "'" + watermarkText + "'" + ':fontcolor=white:fontsize=24:x=w-tw-20:y=20:shadowcolor=black:shadowx=2:shadowy=2" -c:a copy -y "' + outputPath + '"'
      );
      console.log('Watermark added');
    } catch (e) {
      console.log('Watermark failed, saving without it');
      fs.copyFileSync(videoWithSubtitlesPath, outputPath);
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error('Output file was not created');
    }

    var stats = fs.statSync(outputPath);
    console.log('Sending file: ' + Math.round(stats.size / 1024 / 1024) + 'MB');

    res.sendFile(path.resolve(outputPath), {}, function(err) {
      if (err) {
        console.error('Send error:', err);
      } else {
        console.log('File sent successfully');
      }

      setTimeout(function() {
        try {
          var filesToDelete = [listPath, concatenatedPath, videoWithAudioPath, videoWithSubtitlesPath, outputPath];
          filesToDelete = filesToDelete.concat(videoFiles.map(function(f) { return f.path; }));
          filesToDelete = filesToDelete.concat(audioFiles.map(function(f) { return f.path; }));

          filesToDelete.forEach(function(f) {
            if (f && fs.existsSync(f)) fs.unlinkSync(f);
          });

          var srtCleanPath = path.join(__dirname, 'subtitles', 'subs_' + timestamp + '.srt');
          if (fs.existsSync(srtCleanPath)) fs.unlinkSync(srtCleanPath);

          console.log('Temp files cleaned');
        } catch (cleanErr) {
          console.error('Cleanup error:', cleanErr);
        }
      }, 2000);
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    service: 'Video Merge Service',
    version: '3.0',
    features: ['concat', 'audio', 'subtitles', 'watermark']
  });
});

app.get('/info', function(req, res) {
  res.json({
    message: 'POST /merge-video',
    fields: {
      videos: 'Array of video files (mp4)',
      audio: 'Audio file (mp3/m4a)',
      openai_key: 'OpenAI API key for subtitles',
      watermark: 'Watermark text (default @aieye21)',
      subtitles: 'true/false (default true)'
    }
  });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Video Merge Service v3.0 started on port ' + PORT);
});
