import express from 'express';
import cors from 'cors';
import pkg from 'pg';

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

async function initDB() {
  const client = await pool.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      id SERIAL PRIMARY KEY,
      name VARCHAR(20) UNIQUE NOT NULL,
      money INTEGER NOT NULL DEFAULT 0,
      correct INTEGER NOT NULL DEFAULT 0,
      wrong INTEGER NOT NULL DEFAULT 0,
      session VARCHAR(32) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_leaderboard_score
    ON leaderboard (money DESC, correct DESC, wrong ASC);
  `);
  client.release();
  console.log('Database initialized successfully');
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'MoneyWise API is running' });
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, money, correct, wrong
       FROM leaderboard
       ORDER BY money DESC, correct DESC, wrong ASC
       LIMIT 10`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Leaderboard query failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/save', async (req, res) => {
  try {
    let { name, money, correct, wrong, session } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Name is required' });
    }

    name = name.trim().substring(0, 20);

    if (name.length === 0) {
      return res.status(400).json({ error: 'Name cannot be empty' });
    }

    money = parseInt(money) || 0;
    correct = parseInt(correct) || 0;
    wrong = parseInt(wrong) || 0;
    session = (session || '').replace(/[^a-f0-9]/g, '');

    const existing = await pool.query(
      'SELECT id FROM leaderboard WHERE session = $1',
      [session]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Score already saved for this session' });
    }

    const dupCheck = await pool.query(
      'SELECT id, money, correct, wrong FROM leaderboard WHERE name = $1',
      [name]
    );

    if (dupCheck.rows.length > 0) {
      const prev = dupCheck.rows[0];
      if (money > prev.money ||
          (money === prev.money && correct > prev.correct) ||
          (money === prev.money && correct === prev.correct && wrong < prev.wrong)) {
        await pool.query(
          `UPDATE leaderboard
           SET money = $1, correct = $2, wrong = $3, session = $4, created_at = NOW()
           WHERE id = $5`,
          [money, correct, wrong, session, prev.id]
        );
        return res.json({ success: true, updated: true });
      }
      return res.status(409).json({ error: 'Name already taken. Choose a different name.' });
    }

    await pool.query(
      `INSERT INTO leaderboard (name, money, correct, wrong, session)
       VALUES ($1, $2, $3, $4, $5)`,
      [name, money, correct, wrong, session]
    );

    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Name already taken. Choose a different name.' });
    }
    console.error('Save failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  initDB().catch(err => {
    console.error('Database init failed:', err.message);
    process.exit(1);
  });
});