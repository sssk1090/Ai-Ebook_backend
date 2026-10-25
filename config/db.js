const mongoose = require("mongoose");

const connectDB = async () => {
    try {
        const connection = await mongoose.connect(process.env.MONGO_URI);

        console.log(
            `MongoDB Atlas Connected: ${connection.connection.host}`
        );
    } catch (error) {
        console.error("MongoDB Connection Failed:", error.message);

        throw error;
    }
};

module.exports = connectDB;