const fs = require('fs');
const readline = require('readline');

function extractFromAbstract(arxivId, title, abstract) {
  const entities = [];
  const relations = [];
  const entityMap = new Map();
  const seen = new Set();

  function addEntity(name, type) {
    if (!name || name.length < 2) return;
    const key = name.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      entityMap.set(name, type);
      entities.push({ name, type });
    }
  }

  function addRelation(from, rel, to, conf, condition = '', note = '') {
    if (entityMap.has(from) && entityMap.has(to) && from !== to) {
      relations.push({
        from, rel, to,
        confidence: conf,
        condition: condition || '',
        note: note || ''
      });
    }
  }

  const text = (abstract + ' ' + title).trim();
  const lower = text.toLowerCase();

  // Extract models
  const proposedModels = /(?:propose|introduce|present)\s+([A-Z][A-Za-z0-9\-_]*)/g;
  let m;
  const models = new Set();
  while ((m = proposedModels.exec(text)) !== null) {
    if (m[1]) models.add(m[1].trim());
  }
  
  const titleModel = title.split(':')[0].trim();
  if (titleModel.match(/^[A-Z]/)) {
    models.add(titleModel);
  }
  models.forEach(m => addEntity(m, 'model'));

  // Extract datasets
  const datasets = /(?:dataset|benchmark|corpus|on)\s+([A-Z][A-Za-z0-9\-_]*)/gi;
  const datasetSet = new Set();
  while ((m = datasets.exec(text)) !== null) {
    if (m[1] && m[1].length > 1) datasetSet.add(m[1].trim());
  }
  datasetSet.forEach(d => addEntity(d, 'dataset'));

  // Extract tasks
  const tasks = /(?:task|problem|challenge|for)\s+(?:the\s+)?([a-z\s]+?)(?:\.|\,|;|\))/gi;
  const taskSet = new Set();
  while ((m = tasks.exec(text)) !== null) {
    if (m[1]) {
      const t = m[1].toLowerCase().trim();
      if (t.length > 3 && t.length < 60) taskSet.add(t);
    }
  }
  ['link prediction', 'knowledge graph', 'embedding', 'classification', 'prediction'].forEach(t => {
    if (lower.includes(t)) taskSet.add(t);
  });
  taskSet.forEach(t => addEntity(t, 'task'));

  // Extract concepts
  const concepts = new Set();
  ['tensor', 'factorization', 'decomposition', 'embedding', 'neural', 'attention', 
   'transformer', 'lstm', 'rnn', 'cnn', 'deep learning'].forEach(c => {
    if (lower.includes(c)) concepts.add(c);
  });
  concepts.forEach(c => addEntity(c, 'concept'));

  // Extract metrics
  const metrics = new Set();
  ['accuracy', 'f1', 'precision', 'recall', 'bleu', 'rouge', 'mrr', 'hits'].forEach(metric => {
    if (lower.includes(metric)) metrics.add(metric);
  });
  metrics.forEach(m => addEntity(m, 'metric'));

  // Relations: outperforms
  const outperf = /([A-Z][A-Za-z0-9\-_]*)\s+(?:outperforms?|surpass|exceed|beats)\s+([A-Z][A-Za-z0-9\-_]*)/g;
  while ((m = outperf.exec(text)) !== null) {
    if (m[1] && m[2]) addRelation(m[1], 'outperforms', m[2], 0.3);
  }

  // Relations: is_based_on
  const basedOn = /([A-Z][A-Za-z0-9\-_]*)\s+based on\s+([a-z\s]+)/gi;
  while ((m = basedOn.exec(text)) !== null) {
    if (m[1] && m[2]) addRelation(m[1], 'is_based_on', m[2].trim(), 0.2);
  }

  // Relations: applies_to
  if (models.size > 0 && taskSet.size > 0) {
    const modelArr = Array.from(models);
    const taskArr = Array.from(taskSet);
    if (modelArr[0] && taskArr[0]) {
      addRelation(modelArr[0], 'applies_to', taskArr[0], 0.2);
    }
  }

  // Relations: introduces
  if (models.size > 0 && concepts.size > 0) {
    const modelArr = Array.from(models);
    const conceptArr = Array.from(concepts);
    if (modelArr[0] && conceptArr[0] && (lower.includes('propose') || lower.includes('introduce'))) {
      addRelation(modelArr[0], 'introduces', conceptArr[0], 0.2);
    }
  }

  return { entities, relations };
}

// Main processing
const rl = readline.createInterface({
  input: fs.createReadStream('/Users/vadimr/grafema/enox/data/phase1-prompts-batch0.jsonl'),
  crlfDelay: Infinity
});

const output = [];

rl.on('line', (line) => {
  try {
    const data = JSON.parse(line);
    const abstractMatch = data.prompt.match(/ABSTRACT:\s*([\s\S]*?)\s*(?:STEP|KNOWN)/);
    const abstract = abstractMatch ? abstractMatch[1].trim() : '';
    
    if (!abstract) return;

    const result = extractFromAbstract(data.arxiv_id, data.title, abstract);
    output.push(JSON.stringify({
      arxiv_id: data.arxiv_id,
      entities: result.entities,
      relations: result.relations
    }));
    
    console.log(`✓ ${data.arxiv_id}: ${result.entities.length} entities, ${result.relations.length} relations`);
    
  } catch (e) {
    console.error(`✗ Error: ${e.message}`);
  }
});

rl.on('close', () => {
  fs.writeFileSync(
    '/Users/vadimr/grafema/enox/data/phase1-raw-batch0.jsonl',
    output.join('\n') + '\n'
  );
  console.log(`\n✓ Wrote ${output.length} results to phase1-raw-batch0.jsonl`);
});
