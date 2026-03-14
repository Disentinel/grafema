const fs = require('fs');
const readline = require('readline');
const path = require('path');

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
    
    // For now, just collect the data structure
    console.log(`Processing line ${lineNum}: arxiv_id=${data.arxiv_id}`);
    
    results.push({
      arxiv_id: data.arxiv_id,
      title: data.title,
      prompt_length: data.prompt.length
    });
  } catch (e) {
    console.error(`Error parsing line ${lineNum}:`, e.message);
  }
});

rl.on('close', () => {
  console.log(`\nProcessed ${results.length} items`);
  results.forEach(r => {
    console.log(`${r.arxiv_id}: ${r.title.substring(0, 60)}`);
  });
});
