require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

// Connect to Neon Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- VERIFY PIN ---
app.post('/api/verify-pin', async (req, res) => {
  const { name, pin } = req.body;
  try {
    const result = await pool.query('SELECT pin_code FROM family_members WHERE name = $1', [name]);
    if (result.rows.length > 0 && result.rows[0].pin_code === pin) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'Incorrect PIN' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET ALL DATA (Points, Streaks, Daily Log) ---
app.get('/api/data', async (req, res) => {
  try {
    const membersResult = await pool.query('SELECT name, points, current_streak FROM family_members');
    const choresResult = await pool.query('SELECT chore_name, assignee, status, completed_by FROM chore_logs WHERE completed_date = CURRENT_DATE');

    const points = {};
    const streaks = {};
    
    membersResult.rows.forEach(row => { 
      points[row.name] = row.points; 
      streaks[row.name] = row.current_streak;
    });

    res.json({ points: points, streaks: streaks, log: choresResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- TOGGLE CHORE (Instant save & update points) ---
app.post('/api/toggle', async (req, res) => {
  const { choreName, assignee, status, completedBy } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const prevChore = await client.query(
      'SELECT status FROM chore_logs WHERE chore_name = $1 AND assignee = $2 AND completed_date = CURRENT_DATE',
      [choreName, assignee]
    );

    let prevStatus = false;
    if (prevChore.rows.length > 0) prevStatus = prevChore.rows[0].status;

    if (prevStatus !== status && ['Dad', 'Mom', 'Aubriella', 'Christopher', 'Alexia'].includes(completedBy)) {
      const pointChange = status ? 1 : -1;
      await client.query('UPDATE family_members SET points = points + $1 WHERE name = $2', [pointChange, completedBy]);
    }

    await client.query(`
      INSERT INTO chore_logs (chore_name, assignee, completed_by, status, completed_date)
      VALUES ($1, $2, $3, $4, CURRENT_DATE)
      ON CONFLICT (chore_name, assignee, completed_date)
      DO UPDATE SET status = EXCLUDED.status, completed_by = EXCLUDED.completed_by
    `, [choreName, assignee, completedBy, status]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- ADMIN HISTORY ---
app.get('/api/history/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const historyResult = await pool.query(
      'SELECT chore_name, assignee, completed_by FROM chore_logs WHERE status = true AND completed_date = $1',
      [date]
    );
    res.json(historyResult.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET STORE ITEMS ---
app.get('/api/store', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM store_items ORDER BY cost ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PURCHASE PRIZE ---
app.post('/api/purchase', async (req, res) => {
  const { name, itemId } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const itemRes = await client.query('SELECT title, cost FROM store_items WHERE id = $1', [itemId]);
    if (itemRes.rows.length === 0) throw new Error('Item not found');
    const { title, cost } = itemRes.rows[0];

    const userRes = await client.query('SELECT points FROM family_members WHERE name = $1', [name]);
    if (userRes.rows[0].points < cost) {
      return res.json({ success: false, message: 'Not enough points!' });
    }

    await client.query('UPDATE family_members SET points = points - $1 WHERE name = $2', [cost, name]);
    await client.query('INSERT INTO purchases (family_member, item_title, cost) VALUES ($1, $2, $3)', [name, title, cost]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
