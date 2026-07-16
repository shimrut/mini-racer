import { createServer, getServerPort } from '@devvit/web/server';
import { createServerApp } from './server-app.js';

createServer(createServerApp()).listen(getServerPort());
