// server.js
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const port = 3001;
const SECRET_KEY = 'supersecretkey';

const usersPath = path.join(__dirname, 'users.json');
const bidFilePath = path.join(__dirname, 'bidsheet1.json');

app.use(cors());
app.use(bodyParser.json());

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided.' });

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token.' });
    req.user = user;
    next();
  });
}

app.post('/request-vacation', authenticateToken, (req, res) => {
  const { vacationDates } = req.body;
  const { username, name, station, seniority } = req.user;

  if (!vacationDates || vacationDates.length === 0) {
    return res.status(400).json({ message: 'You must select at least one vacation date.' });
  }

  const cleanedDates = [...new Set(vacationDates.map(d => d.trim()))];
  if (cleanedDates.length > 14) {
    return res.status(400).json({ message: 'You can only request up to 14 vacation dates.' });
  }

  let bids = fs.existsSync(bidFilePath) ? JSON.parse(fs.readFileSync(bidFilePath)) : [];

  // Remove any old requests from the same user/station
  bids = bids.filter(bid => !(bid.Username === username && bid.Location === station));

  // Save the initial bid request
  bids.push({
    Username: username,
    Name: name,
    Seniority: seniority,
    Location: station,
    VacationDates: cleanedDates
  });

  fs.writeFileSync(bidFilePath, JSON.stringify(bids, null, 2));
  res.json({ message: 'Vacation request saved.' });
});

app.get('/my-vacations', authenticateToken, (req, res) => {
  const { username, station } = req.user;
  const bids = fs.existsSync(bidFilePath) ? JSON.parse(fs.readFileSync(bidFilePath)) : [];
  const match = bids.find(b => b.Username === username && b.Location === station);
  res.json(match?.VacationDates || []);
});

app.post('/signup', async (req, res) => {
  const { username, name, password, station, seniority } = req.body;
  if (!username || !name || !password || !station || !seniority) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  let users = fs.existsSync(usersPath) ? JSON.parse(fs.readFileSync(usersPath)) : [];
  if (users.some(u => u.username === username)) {
    return res.status(400).json({ message: 'Username already exists.' });
  }

  const newUser = {
    username,
    name,
    station,
    seniority,
    passwordHash: await bcrypt.hash(password, 10),
  };

  users.push(newUser);
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
  res.status(201).json({ message: 'User created successfully.' });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const users = fs.existsSync(usersPath) ? JSON.parse(fs.readFileSync(usersPath)) : [];
  const user = users.find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ message: 'Invalid credentials.' });
  }

  const token = jwt.sign({
    username: user.username,
    name: user.name,
    station: user.station,
    seniority: user.seniority
  }, SECRET_KEY, { expiresIn: '2h' });

  res.json({ token });
});

app.get('/me', authenticateToken, (req, res) => {
  res.json(req.user);
});

app.get('/generate-calendar', (req, res) => {
  const result = getInitialOutput(2026);

  if (!fs.existsSync(bidFilePath)) {
    return res.status(404).json({ message: 'No vacation bids found.' });
  }

  const bidData = JSON.parse(fs.readFileSync(bidFilePath, 'utf8'));
  const sortedBids = bidData.sort((a, b) => a.Seniority - b.Seniority);

  const grantedMap = {};

  sortedBids.forEach((bid) => {
    bid.VacationDates.forEach((date) => {
      assignVacationDate(date, bid, result, grantedMap);
    });
  });

  // Update bidsheet with granted dates
  const updatedBids = sortedBids.map(bid => ({
    ...bid,
    VacationDates: grantedMap[bid.Username]?.[bid.Location] || []
  }));

  fs.writeFileSync(bidFilePath, JSON.stringify(updatedBids, null, 2));

  res.json(result);
});

function assignVacationDate(date, bid, result, grantedMap) {
  if (!result[date]) result[date] = {};
  if (!result[date][bid.Location]) result[date][bid.Location] = [];

  const slot = result[date][bid.Location];

  // Prevent duplicate username at this station/date
  if (slot.some(b => b.Username === bid.Username)) return;

  if (slot.length < 3) {
    slot.push(bid);
    addGranted(bid, date, grantedMap);
  } else {
    const lowestSeniority = Math.max(...slot.map(b => b.Seniority));
    const lowestIndex = slot.findIndex(b => b.Seniority === lowestSeniority);

    if (bid.Seniority < lowestSeniority) {
      const bumped = slot[lowestIndex];
      slot[lowestIndex] = bid;
      addGranted(bid, date, grantedMap);
      findBackfillDate(bumped, result, grantedMap);
    } else {
      findBackfillDate(bid, result, grantedMap);
    }
  }
}

function findBackfillDate(bid, result, grantedMap) {
  let date = new Date(2026, 10, 15); // Nov 15
  const end = new Date(2026, 11, 31);

  while (date <= end) {
    const d = date.toISOString().split('T')[0];
    if (!result[d]) result[d] = {};
    if (!result[d][bid.Location]) result[d][bid.Location] = [];

    const slot = result[d][bid.Location];

    if (slot.length < 3 && !slot.some(b => b.Username === bid.Username)) {
      slot.push(bid);
      addGranted(bid, d, grantedMap);
      return;
    }
    date.setDate(date.getDate() + 1);
  }
}

function addGranted(bid, date, grantedMap) {
  if (!grantedMap[bid.Username]) grantedMap[bid.Username] = {};
  if (!grantedMap[bid.Username][bid.Location]) grantedMap[bid.Username][bid.Location] = [];
  grantedMap[bid.Username][bid.Location].push(date);
}

function getInitialOutput(year) {
  const daysObj = {};
  let date = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  while (date < end) {
    daysObj[date.toISOString().split('T')[0]] = null;
    date.setDate(date.getDate() + 1);
  }
  return daysObj;
}

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
