require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors()); // Allows your frontend to talk to this backend
app.use(express.json());

// Connect to Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// GET Route: Send points and today's chores to the app
app.get('/api/data', async (req, res) => {
  try {
    const pointsResult = await pool.query('SELECT name, points FROM family_members');
    const choresResult = await pool.query('SELECT chore_name, assignee, status, completed_by FROM chore_logs WHERE completed_date = CURRENT_DATE');

    // Format points into a simple object: { "Dad": 5, "Mom": 10 }
    const points = {};
    pointsResult.rows.forEach(row => { points[row.name] = row.points; });

    res.json({ points: points, log: choresResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Route: Handle a checkbox click
app.post('/api/toggle', async (req, res) => {
  const { choreName, assignee, status, completedBy } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN'); // Start transaction

    // 1. Check if this chore was already checked today to prevent double-counting points
    const prevChore = await client.query(
      'SELECT status FROM chore_logs WHERE chore_name = $1 AND assignee = $2 AND completed_date = CURRENT_DATE',
      [choreName, assignee]
    );

    let prevStatus = false;
    if (prevChore.rows.length > 0) {
      prevStatus = prevChore.rows[0].status;
    }

    // 2. Only update the point bank if the status actually changed
    if (prevStatus !== status && ['Dad', 'Mom', 'Aubriella', 'Christopher', 'Alexia'].includes(completedBy)) {
      const pointChange = status ? 1 : -1;
      await client.query(
        'UPDATE family_members SET points = points + $1 WHERE name = $2', 
        [pointChange, completedBy]
      );
    }

    // 3. Upsert the chore log (Insert it, or update it if it already exists)
    await client.query(`
      INSERT INTO chore_logs (chore_name, assignee, completed_by, status, completed_date)
      VALUES ($1, $2, $3, $4, CURRENT_DATE)
      ON CONFLICT (chore_name, assignee, completed_date)
      DO UPDATE SET status = EXCLUDED.status, completed_by = EXCLUDED.completed_by
    `, [choreName, assignee, completedBy, status]);

    await client.query('COMMIT'); // Save transaction
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK'); // Cancel if something broke
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));