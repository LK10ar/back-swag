// Insère 4 albums d'exemple : `npm run seed` (ajoute --force pour repartir de zéro)
import 'dotenv/config';
import mongoose from 'mongoose';
import Album from './models/Album.js';

const px = (id, w = 1200) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${w}`;
const photos = (ids) => ids.map((id) => ({ url: px(id, 1200), caption: '' }));

const DATA = [
  { title: 'BACKSTAGE FIRE', year: '2025', location: 'Paris, FR', accent: 'green', cover: px(33418892), ids: [33418892, 16118361, 7715830, 20733964, 632305] },
  { title: 'DECIBEL KINGS', year: '2024', location: 'Berlin, DE', accent: 'orange', cover: px(8041217), ids: [8041217, 18004195, 23947891, 922319, 31020032] },
  { title: 'SHADOW METAL', year: '2024', location: 'Oslo, NO', accent: 'pink', cover: px(15129779), ids: [15129779, 417475, 15865126, 4073982, 6445429] },
  { title: 'NEON CARNAGE', year: '2023', location: 'Tokyo, JP', accent: 'blue', cover: px(18671362), ids: [18671362, 8130647, 5824779, 28096553, 7715474] },
];

await mongoose.connect(process.env.MONGODB_URI);
if ((await Album.countDocuments()) > 0 && !process.argv.includes('--force')) {
  console.log('La base contient déjà des albums. Relance avec --force pour tout remplacer.');
} else {
  await Album.deleteMany({});
  await Album.insertMany(DATA.map(({ ids, ...a }, i) => ({ ...a, order: i, photos: photos(ids) })));
  console.log('4 albums créés.');
}
await mongoose.disconnect();
