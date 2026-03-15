require('dotenv').config();
const mysql = require('mysql2');

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Retry connection on startup to handle MySQL not being ready yet
function connectWithRetry(retries = 10, delay = 3000) {
  db.getConnection((err, connection) => {
    if (err) {
      if (retries === 0) {
        console.error('MySQL connection failed after all retries:', err.message);
        process.exit(1);
      }
      console.log(`MySQL not ready, retrying in ${delay / 1000}s... (${retries} left)`);
      setTimeout(() => connectWithRetry(retries - 1, delay), delay);
      return;
    }
    console.log('MySQL Connected');
    connection.release();
  });
}

connectWithRetry();

module.exports = db;
