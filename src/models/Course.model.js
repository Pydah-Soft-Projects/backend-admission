import mongoose from 'mongoose';

const { Schema } = mongoose;

const courseSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    code: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    description: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

courseSchema.index({ name: 1 });
courseSchema.index({ code: 1 });

const Course = mongoose.model('Course', courseSchema);

export default Course;



