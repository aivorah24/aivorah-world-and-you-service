require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-world-and-you-service' }));

app.use('/daily-tidbit', require('./routes/daily-tidbit'));
app.use('/world',        require('./routes/world'));

const PORT = process.env.PORT || 3010;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah World & You service running on http://localhost:${PORT}`);
  });
}

module.exports = app;
