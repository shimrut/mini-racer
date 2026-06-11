import { getDailyChallengePlaylist } from './game/daily-challenge/service.js';
getDailyChallengePlaylist().then(playlist => {
  console.log(playlist.map(c => ({ id: c.id, trackKey: c.trackKey })));
});
