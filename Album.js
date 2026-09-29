import mongoose from 'mongoose';

const photoSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    caption: { type: String, default: '' },
  },
  { _id: true },
);

const albumSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    year: { type: String, default: '', trim: true, maxlength: 10 },
    location: { type: String, default: '', trim: true, maxlength: 80 },
    accent: { type: String, enum: ['green', 'orange', 'pink', 'blue'], default: 'green' },
    cover: { type: String, default: '' },
    order: { type: Number, default: 0 },
    photos: { type: [photoSchema], default: [] },
  },
  { timestamps: true },
);

export default mongoose.model('Album', albumSchema);
