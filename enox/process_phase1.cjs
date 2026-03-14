const fs = require('fs');
const readline = require('readline');

// Create a readable stream for the input file
const rl = readline.createInterface({
  input: fs.createReadStream('/Users/vadimr/grafema/enox/data/phase1-prompts-batch0.jsonl'),
  crlfDelay: Infinity
});

const results = [];
let lineNum = 0;

rl.on('line', (line) => {
  lineNum++;
  try {
    const data = JSON.parse(line);
    console.log(`Line ${lineNum}: arxiv_id=${data.arxiv_id}`);
    results.push(data);
  } catch (e) {
    console.error(`Error on line ${lineNum}:`, e.message);
  }
});

rl.on('close', () => {
  console.log(`\nTotal items: ${results.length}`);
});
