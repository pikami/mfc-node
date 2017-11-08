'use strict';

var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var string = require('string');
var yaml = require('js-yaml');
var colors = require('colors');
var childProcess = require('child_process');
var mkdirp = require('mkdirp');
var path = require('path');
var moment = require('moment');
var _ = require('underscore');
var Queue = require('promise-queue');
var filewalker = require('filewalker');

function getCurrentDateTime() {
  return moment().format('HH:mm:ss');
}

function printMsg(msg) {
  console.log(`[${getCurrentDateTime()}]`, msg);
}

function printErrorMsg(msg) {
  console.log(`[${getCurrentDateTime()}]`, colors.red('[ERROR]'), msg);
}

var config = yaml.safeLoad(fs.readFileSync('convert.yml', 'utf8'));

var srcDirectory = path.resolve(config.srcDirectory || './complete');
var dstDirectory = path.resolve(config.dstDirectory || './converted');
var dirScanInterval = config.dirScanInterval || 300;
var maxConcur = config.maxConcur || 1;

Queue.configure(Promise.Promise);

var queue = new Queue(maxConcur, Infinity);

mkdirp.sync(srcDirectory);
mkdirp.sync(dstDirectory);

function getFiles() {
  var files = [];

  return new Promise((resolve, reject) => {
    filewalker(srcDirectory, { maxPending: 1, matchRegExp: /(\.ts|\.flv)$/ })
      .on('file', p => {
        // select only "not hidden" files
        if (!p.match(/(^\.|\/\.)/)) {
          // push path relative to srcDirectory
          files.push(p);
        }
      })
      .on('done', () => {
        resolve(files);
      })
      .walk();
  });
}

function getTsSpawnArguments(srcFile, dstFile) {
  return [
    '-i',
    srcFile,
    '-y',
    '-hide_banner',
    '-loglevel',
    'panic',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-bsf:a',
    'aac_adtstoasc',
    '-copyts',
    dstFile
  ];
}

function getFlvSpawnArguments(srcFile, dstFile) {
  return [
    '-i',
    srcFile,
    '-y',
    '-hide_banner',
    '-loglevel',
    'panic',
    '-movflags',
    '+faststart',
    '-c:v',
    'copy',
    '-strict',
    '-2',
    '-q:a',
    '100',
    dstFile
  ];
}

function convertFile(srcFile) {
  return new Promise((resolve, reject) => {
    var dstPath = path.resolve(path.dirname(path.join(dstDirectory, srcFile)));
    var dstFile;
    var spawnArguments;
    var startTs = moment();

    if (string(srcFile).endsWith('.ts')) {
      dstFile = path.basename(srcFile, '.ts') + '.mp4';
      spawnArguments = getTsSpawnArguments(path.join(srcDirectory, srcFile), path.join(dstPath, '~' + dstFile));
    } else {
      dstFile = path.basename(srcFile, '.flv') + '.mp4';
      spawnArguments = getFlvSpawnArguments(path.join(srcDirectory, srcFile), path.join(dstPath, '~' + dstFile));
    }

    // make destination path
    mkdirp(dstPath, err => {
      if (err) {
        printErrorMsg(`Failed to create ${dstPath}`);

        return; // skip if we could not create a destination dir
      }
    });

    printMsg(`Starting ${colors.green(srcFile)}...`);

    var convertProcess = childProcess.spawn('ffmpeg', spawnArguments);

    convertProcess.on('close', status => {
      if (status !== 0) {
        reject(`Failed to convert ${srcFile}`);
      } else {
        Promise.try(() => {
          return config.deleteAfter
            ? fs.unlinkAsync(path.join(srcDirectory, srcFile))
            : fs.renameAsync(path.join(srcDirectory, srcFile), path.join(srcDirectory, srcFile + '.bak'));
        })
        .then(() => {
          fs.renameAsync(path.join(dstPath, '~' + dstFile), path.join(dstPath, dstFile));
        })
        .then(() => {
          let duration = moment.duration(moment().diff(startTs)).asSeconds().toString() + ' s';

          printMsg(`Finished ${colors.green(srcFile)} after ${colors.magenta(duration)}`);

          resolve();
        })
        .catch(err => {
          reject(err.toString());
        });
      }
    });
  });
}

function mainLoop() {
  var startTs = moment().unix();

  Promise
    .try(() => getFiles())
    .then(files => new Promise((resolve, reject) => {
      printMsg(files.length + ' file(s) to convert');

      if (files.length === 0) {
        resolve();
      } else {
        _.each(files, file => {
          queue
            .add(() => convertFile(file))
            .then(() => {
              if ((queue.getPendingLength() + queue.getQueueLength()) === 0) {
                resolve();
              }
            })
            .catch(err => {
              printErrorMsg(err);
            });
        });
      }
    }))
    .catch(err => {
      if (err) {
        printErrorMsg(err);
      }
    })
    .finally(() => {
      var seconds = startTs - moment().unix() + dirScanInterval;

      if (seconds < 5) {
        seconds = 5;
      }

      printMsg('Done, will scan the folder in ' + seconds + ' seconds.');

      setTimeout(mainLoop, seconds * 1000);
    });
}

mainLoop();
