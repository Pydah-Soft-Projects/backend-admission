import mongoose from 'mongoose';

const admissionSequenceSchema = new mongoose.Schema(
  {
    year: {
      type: Number,
      required: true,
      unique: true,
    },
    lastSequence: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

const AdmissionSequence = mongoose.model('AdmissionSequence', admissionSequenceSchema);

export default AdmissionSequence;


