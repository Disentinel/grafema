const fs = require('fs');
const readline = require('readline');

// Relation confidence levels
const CONFIDENCE = {
  explicit: 0.3,
  moderate: 0.2,
  weak: 0.1
};

// Main extraction function
function extractFromAbstract(arxivId, title, abstract) {
  const entities = [];
  const relations = [];
  const entityMap = new Map(); // name -> type

  // Helper to add entity
  function addEntity(name, type) {
    if (!entityMap.has(name)) {
      entityMap.set(name, type);
      entities.push({ name, type });
    }
  }

  // Helper to add relation
  function addRelation(from, rel, to, conf, condition = '', note = '') {
    if (entityMap.has(from) && entityMap.has(to)) {
      relations.push({
        from, rel, to,
        confidence: conf,
        condition,
        note
      });
    }
  }

  // Parse abstract for common patterns
  const text = abstract + ' ' + title;
  
  // Extract methods/models (typically capitalized names or in quotes)
  const modelPatterns = [
    /(?:propose|introduce|present)\s+([A-Z][A-Za-z0-9\-_]*)/g,
    /\b([A-Z][A-Za-z0-9\-_]*)\s+(?:model|method|approach|framework)/g,
    /(?:our|the)\s+([A-Z][A-Za-z0-9\-_]*)/g
  ];

  const models = new Set();
  modelPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1] && match[1].length > 2) {
        models.add(match[1]);
      }
    }
  });

  // Extract datasets
  const datasetPatterns = [
    /(?:dataset|benchmark|corpus)s?:?\s*([A-Z][A-Za-z0-9\-_]*)/gi,
    /on\s+([A-Z][A-Za-z0-9\-_]*)\s+(?:dataset|benchmark)/gi
  ];

  const datasets = new Set();
  datasetPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) datasets.add(match[1]);
    }
  });

  // Common NLP/ML tasks
  const taskPatterns = [
    /(?:task|problem)\s+(?:of\s+)?([a-z\s]+?)(?:\.|,|$)/gi,
    /for\s+([a-z\s]+?)\s+(?:task|problem)/gi,
    /(link\s+prediction|knowledge\s+graph\s+completion|sentiment\s+analysis|machine\s+translation|question\s+answering|text\s+classification|named\s+entity\s+recognition|part\-of\-speech\s+tagging|dependency\s+parsing|semantic\s+similarity|paraphrase\s+detection)/gi
  ];

  const tasks = new Set();
  taskPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) tasks.add(match[1].toLowerCase().trim());
    }
  });

  // Concepts and techniques
  const conceptPatterns = [
    /(?:based on|using|through)\s+([a-z\s]+?)(?:\.|,)/gi,
    /(tensor\s+(?:decomposition|factorization)|embedding|transformer|attention|rnn|lstm|bert|gpt|neural|convolution)/gi
  ];

  const concepts = new Set();
  conceptPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) concepts.add(match[1].toLowerCase().trim());
    }
  });

  // Metrics
  const metricPatterns = [
    /(accuracy|f1|precision|recall|bleu|rouge|mrr|hits@10|hits@3|hits@1)/gi,
    /(?:measure|metric|evaluation)\s+(?:of\s+)?([a-z0-9\-]+)/gi
  ];

  const metrics = new Set();
  metricPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) metrics.add(match[1].toLowerCase().trim());
    }
  });

  // Add extracted entities
  models.forEach(m => addEntity(m, 'model'));
  datasets.forEach(d => addEntity(d, 'dataset'));
  tasks.forEach(t => addEntity(t, 'task'));
  concepts.forEach(c => addEntity(c, 'concept'));
  metrics.forEach(m => addEntity(m, 'metric'));

  // Add the main title as a method/model if not already added
  addEntity(title, 'model');

  // Extract relations
  const explicitRelations = [
    { pattern: /(\w+)\s+(?:outperforms?|surpass|exceed|beats)\s+(\w+)/gi, rel: 'outperforms' },
    { pattern: /based on\s+(\w+)/gi, rel: 'is_based_on' },
    { pattern: /(\w+)\s+(?:extends?|improves?|enhances?)\s+(\w+)/gi, rel: 'extends' },
    { pattern: /uses?\s+(\w+)/gi, rel: 'uses' },
    { pattern: /(\w+)\s+applies? to\s+(\w+)/gi, rel: 'applies_to' },
    { pattern: /(?:introduce|propose|present)\s+(\w+)(?:\s+for)?\s+(\w+)/gi, rel: 'introduces' }
  ];

  explicitRelations.forEach(({pattern, rel}) => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const from = match[1];
      const to = match[2];
      if (from && to && entityMap.has(from) && entityMap.has(to)) {
        addRelation(from, rel, to, CONFIDENCE.explicit);
      }
    }
  });

  // Infer common relations
  if (models.size > 1) {
    const modelArray = Array.from(models);
    // Models often compare against baselines
    if (text.includes('baseline') || text.includes('previous') || text.includes('state-of-the-art')) {
      for (let i = 1; i < modelArray.length; i++) {
        addRelation(modelArray[0], 'outperforms', modelArray[i], CONFIDENCE.weak, 'inferred from comparison context', 'baseline comparison');
      }
    }
  }

  // If dataset mentioned with task
  if (datasets.size > 0 && tasks.size > 0) {
    const taskArray = Array.from(tasks);
    const datasetArray = Array.from(datasets);
    taskArray.forEach(task => {
      datasetArray.forEach(dataset => {
        addRelation(dataset, 'applies_to', task, CONFIDENCE.moderate, '', 'dataset for task');
      });
    });
  }

  return { entities, relations };
}

// Main processing loop
const rl = readline.createInterface({
  input: fs.createReadStream('/Users/vadimr/grafema/enox/data/phase1-prompts-batch0.jsonl'),
  crlfDelay: Infinity
});

const output = [];

rl.on('line', (line) => {
  try {
    const data = JSON.parse(line);
    
    // Extract the abstract from the prompt
    const abstractMatch = data.prompt.match(/ABSTRACT:\s*([\s\S]*?)\s*(?:STEP|KNOWN)/);
    const abstract = abstractMatch ? abstractMatch[1].trim() : '';
    
    const { entities, relations } = extractFromAbstract(data.arxiv_id, data.title, abstract);
    
    output.push(JSON.stringify({
      arxiv_id: data.arxiv_id,
      entities,
      relations
    }));
    
  } catch (e) {
    console.error(`Error processing entry:`, e.message);
  }
});

rl.on('close', () => {
  // Write output
  fs.writeFileSync(
    '/Users/vadimr/grafema/enox/data/phase1-raw-batch0.jsonl',
    output.join('\n') + '\n'
  );
  console.log(`Processed ${output.length} papers and wrote to phase1-raw-batch0.jsonl`);
});
