import afs from 'node:fs/promises';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import url from 'url';

import exitOnEpipe from 'exit-on-epipe';
import express from 'express';
import WebRTC from '@koush/wrtc';
import {WebSocketServer} from 'ws';
import {Reader,Writer} from '@dosy/wav';

const DEBUG = true;

let app;

addHandlers();
startServer();

function addHandlers() {
  app = express();
  app.use(express.static(path.resolve('src', 'client')));

  app.get('/httpstream.wav', (request, response) => {
    response.writeHead(200, {
      'Connection': 'keep-alive',
      'Content-Type': 'audio/wav'
    });


    const streamer = fs.createReadStream(path.resolve('assets', 'test.wav'));
    streamer.pipe(response);
    //exitOnEpipe(response);

    streamer.on('close', function() {
      response.end();
    });

    request.on('close', function() {
      response.end();
      streamer.close();
    });
  });
}

async function startServer() {
  const sockets = new Set();
  const PORT = Number.isInteger(process.argv[2]) ? parseInt(process.argv[2]) : 8080;
  const SSL_CERTS = process.env.LOCAL_HTTPS ? 'localhost-sslcerts' : 'sslcerts';
  const GO_SECURE = fs.existsSync(path.resolve(os.homedir(), SSL_CERTS, 'privkey.pem'));
  const secure_options = {};

  try {
    const sec = {
      key: fs.readFileSync(path.resolve(os.homedir(), SSL_CERTS, 'privkey.pem')),
      cert: fs.readFileSync(path.resolve(os.homedir(), SSL_CERTS, 'fullchain.pem')),
      ca: fs.existsSync(path.resolve(os.homedir(), SSL_CERTS, 'chain.pem')) ? 
          fs.readFileSync(path.resolve(os.homedir(), SSL_CERTS, 'chain.pem'))
        :
          undefined
    };
    Object.assign(secure_options, sec);
  } catch(e) {
    console.error(e);
    console.warn(`No certs found so will use insecure no SSL.`); 
  }

  const secure = GO_SECURE && secure_options.cert && secure_options.key;
  const protocol = secure ? https : http;
  const httpServer = protocol.createServer.apply(protocol, secure ? [secure_options, app] : [app]);
  const websocketServerWaveChunks1 = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  const websocketServerWaveStream2 = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });

  let shuttingDown = false;

  const shutDown = () => {
    if ( shuttingDown ) return;
    shuttingDown = true;
    httpServer.close(() => console.info(`Server closed on SIGINT`));
    sockets.forEach(socket => {
      try { socket.destroy() } catch(e) {
        DEBUG && console.warn(`MAIN SERVER: port ${httpServer_port}, error closing socket`, e)
      }
    });
    process.exit(0);
  };

  httpServer.on('connection', socket => {
    sockets.add(socket);
    console.log('http connection');
    socket.on('close', () => sockets.delete(socket));
  });

  httpServer.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    console.log('http upgrade');
    const {pathname} = url.parse(req.url);
    switch(pathname) {
      case "/wavechunks1": {
        websocketServerWaveChunks1.handleUpgrade(req, socket, head, ws => {
          websocketServerWaveChunks1.emit('connection', ws);
        });
      }; break;
      case "/wavestream2": {
        websocketServerWaveStream2.handleUpgrade(req, socket, head, ws => {
          websocketServerWaveStream2.emit('connection', ws);
        });
      }; break;
      default: {
        socket.destroy();
      }; break;
    }

    socket.on('close', () => sockets.delete(socket));
  });

  websocketServerWaveChunks1.on('connection',  ws => {
    try {
      console.log('ws (wave chunks) connection (server #1)');
      const streamer = fs.createReadStream(path.resolve('assets', 'test.wav'));
      let waveFormat;
      const waveRider = new Reader();

      waveRider.on('format', format => {
        try {
          waveFormat = format;
          DEBUG && console.log({waveFormat});
          waveRider.on('data', data => {
            const packet = new Writer(format);
            let packetData = Buffer.from([]);
            packet.on('data', data => {
              packetData = Buffer.concat([packetData, data]);
              DEBUG && console.log({packetData});
            });
            packet.on('end', () => ws.send(packetData));
            packet.write(data);
            packet.end();
          });
        } catch(e) {
          console.warn(e);
        }
      })

      streamer.pipe(waveRider);

      //streamer.on('data', data => ws.send(data));
      //streamer.on('close', () => ws.close());
      ws.on('message', async msg => {
        console.log('msg: %s', msg);
      });
      ws.on('error', err => console.warn('WebSocket error', err));
    } catch(e) {
      console.warn(e);
    }
  });

  websocketServerWaveStream2.on('connection',  ws => {
    try {
      console.log('ws (wave header + pcm stream) connection (server #2)');
      const streamer = fs.createReadStream(path.resolve('assets', 'test2.wav'));
      let waveFormat;
      const waveRider = new Reader();

      waveRider.on('format', format => {
        try {
          waveFormat = format;
          DEBUG && console.log({waveFormat});
          ws.send(JSON.stringify({format}));
          waveRider.on('data', data => {
            console.log(`sending`, data);
            ws.send(data);
          });
        } catch(e) {
          console.warn(e);
        }
      })

      streamer.pipe(waveRider);

      ws.on('message', async msg => {
        console.log('msg: %s', msg);
      });
      ws.on('error', err => console.warn('WebSocket error', err));
    } catch(e) {
      console.warn(e);
    }
  });

  let resolve, reject;

  const startup = new Promise((res, rej) => (resolve = res, reject = rej));

  httpServer.listen(PORT, err => {
    if ( err ) {
      console.error('Server start error', err);
      reject();
      throw err;
    }
    console.info({serverUp:{port:PORT, at:new Date}});
    resolve();
  });

  await startup;

  console.warn('Shutdown is burying errors');
  //process.on('SIGINT', shutDown);
  //process.on('exit', shutDown);
  //// nodemon restart
  //process.on('SIGUSR2', shutDown);

  return httpServer;
}

