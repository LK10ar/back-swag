import mongoose from 'mongoose';

const photoSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    // image | video (fichier .mp4/.webm…) | youtube (lien YouTube)
    type: { type: String, enum: ['image', 'video', 'youtube'], default: 'image' },
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
    // Couleurs personnalisées (#rrggbb). Vide = couleur par défaut du site
    frameColor: { type: String, default: '' },
    numberColor: { type: String, default: '' },
    buttonColor: { type: String, default: '' },
    hoverColor: { type: String, default: '' },
    cover: { type: String, default: '' },
    order: { type: Number, default: 0 },
    photos: { type: [photoSchema], default: [] },
  },
  { timestamps: true },
);

export default mongoose.model('Album', albumSchema);
