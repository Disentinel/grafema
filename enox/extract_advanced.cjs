const fs = require('fs');
const readline = require('readline');

// Known entities and their types from the broader ML/AI domain
const KNOWN_MODELS = new Set([
  'DistMult', 'ComplEx', 'ConvE', 'ConvKB', 'RotatE', 'RESCAL',
  'TransE', 'TransH', 'TransR', 'TransD',
  'BERT', 'GPT', 'RoBERTa', 'ELMo', 'XLNet', 'T5', 'ELECTRA',
  'CNN', 'RNN', 'LSTM', 'GRU', 'Transformer', 'Attention',
  'ResNet', 'VGG', 'AlexNet', 'Inception',
  'Word2Vec', 'GloVe', 'FastText', 'ELMo',
  'TuckER', 'RotatE', 'DKN'
]);

const KNOWN_DATASETS = new Set([
  'WN18', 'FB15k', 'YAGO', 'Freebase', 'NELL', 'DBpedia',
  'ImageNet', 'MNIST', 'CIFAR', 'SQuAD', 'GLUE', 'SuperGLUE',
  'Wikipedia', 'CommonCrawl', 'BookCorpus',
  'Penn Treebank', 'OntoNotes', 'CoNLL'
]);

const KNOWN_TASKS = new Set([
  'link prediction', 'knowledge graph completion',
  'sentiment analysis', 'text classification', 'named entity recognition',
  'machine translation', 'question answering', 'semantic similarity',
  'part-of-speech tagging', 'dependency parsing',
  'image classification', 'object detection', 'semantic segmentation',
  'paraphrase detection', 'textual entailment',
  'relation extraction', 'entity linking', 'coreference resolution'
]);

const KNOWN_METRICS = new Set([
  'accuracy', 'f1', 'precision', 'recall', 'auc', 'roc',
  'bleu', 'rouge', 'meteor', 'perplexity',
  'mrr', 'ndcg', 'map',
  'hits@1', 'hits@3', 'hits@10',
  'mse', 'mae', 'rmse'
]);

const KNOWN_CONCEPTS = new Set([
  'embedding', 'representation learning', 'feature learning',
  'tensor decomposition', 'tensor factorization',
  'neural network', 'deep learning', 'machine learning',
  'attention mechanism', 'self-attention', 'cross-attention',
  'convolutional neural network', 'recurrent neural network',
  'transformer', 'encoder', 'decoder', 'sequence-to-sequence',
  'pre-training', 'fine-tuning', 'transfer learning',
  'regularization', 'dropout', 'batch normalization',
  'optimization', 'gradient descent', 'backpropagation',
  'loss function', 'cross entropy',
  'knowledge graph', 'semantic web', 'linked data',
  'information extraction', 'knowledge extraction',
  'entity resolution', 'record linkage',
  'matrix factorization', 'low-rank approximation'
]);

function extractFromAbstract(arxivId, title, abstract) {
  const entities = [];
  const relations = [];
  const entityMap = new Map(); // name -> type
  const seen = new Set(); // Avoid duplicates

  // Helper to add entity (case-insensitive uniqueness)
  function addEntity(name, type) {
    if (!name || name.length < 2) return;
    const key = name.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      entityMap.set(name, type);
      entities.push({ name, type });
    }
  }

  // Helper to add relation
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

  // 1. Extract models/methods (capitalized names or known models)
  const modelCandidates = new Set();
  
  // Known models
  KNOWN_MODELS.forEach(m => {
    if (lower.includes(m.toLowerCase())) {
      modelCandidates.add(m);
    }
  });

  // Extract proposed methods (pattern: "propose/introduce X" or "X: a...")
  const proposePattern = /(?:propose|introduce|present|describe)\s+([A-Z][A-Za-z0-9\-_]*(?:\s+[A-Z][A-Za-z0-9\-_]*)?)/g;
  let match;
  while ((match = proposePattern.exec(text)) !== null) {
    if (match[1] && match[1].length > 2 && !match[1].includes('a ')) {
      modelCandidates.add(match[1].trim());
    }
  }

  // Add title as primary model if it looks like one
  const titleWords = title.split(':')[0].trim().split(/\s+/);
  if (titleWords[0].length > 2 && titleWords[0].match(/^[A-Z]/)) {
    modelCandidates.add(titleWords[0]);
  }

  modelCandidates.forEach(m => addEntity(m, 'model'));

  // 2. Extract datasets
  const datasetCandidates = new Set();
  
  KNOWN_DATASETS.forEach(d => {
    if (lower.includes(d.toLowerCase())) {
      datasetCandidates.add(d);
    }
  });

  // Pattern: "dataset X" or "on X" before datasets
  const datasetPattern = /(?:dataset|benchmark|corpus|evaluation|tested on|evaluated on|benchmark suite)\s+(?:of\s+)?([A-Z][A-Za-z0-9\-_]*(?:\s+[A-Z][A-Za-z0-9\-_]*)?)/gi;
  while ((match = datasetPattern.exec(text)) !== null) {
    if (match[1] && match[1].length > 1 && !match[1].includes('the ')) {
      datasetCandidates.add(match[1].trim());
    }
  }

  datasetCandidates.forEach(d => addEntity(d, 'dataset'));

  // 3. Extract tasks (combine known tasks + patterns)
  const taskCandidates = new Set();
  
  KNOWN_TASKS.forEach(t => {
    if (lower.includes(t.toLowerCase())) {
      taskCandidates.add(t);
    }
  });

  // Extract named tasks from text
  const taskPattern = /(?:task|problem|challenge)\s+of\s+([a-z\s]+?)(?:\.|\,|;|$)/gi;
  while ((match = taskPattern.exec(text)) !== null) {
    if (match[1]) {
      const task = match[1].toLowerCase().trim();
      if (task.length > 3 && task.length < 60) {
        taskCandidates.add(task);
      }
    }
  });

  taskCandidates.forEach(t => addEntity(t, 'task'));

  // 4. Extract concepts/techniques
  const conceptCandidates = new Set();
  
  KNOWN_CONCEPTS.forEach(c => {
    if (lower.includes(c.toLowerCase())) {
      conceptCandidates.add(c);
    }
  });

  // Extract phrases after "using", "based on", "through"
  const conceptPattern = /(?:based on|using|via|through|employs?|leverages?|utilizes?)\s+([a-z\s]+?)(?:\.|\,|;|to\s|for\s)/gi;
  while ((match = conceptPattern.exec(text)) !== null) {
    if (match[1]) {
      const concept = match[1].toLowerCase().trim();
      if (concept.length > 3 && concept.length < 80 && !concept.includes('the')) {
        conceptCandidates.add(concept);
      }
    }
  });

  conceptCandidates.forEach(c => addEntity(c, 'concept'));

  // 5. Extract metrics
  const metricCandidates = new Set();
  
  KNOWN_METRICS.forEach(m => {
    if (lower.includes(m.toLowerCase())) {
      metricCandidates.add(m);
    }
  });

  metricCandidates.forEach(m => addEntity(m, 'metric'));

  // 6. Extract baselines (usually other named models mentioned)
  const baselinePattern = /(?:baseline|baseline model|previous|state-of-the-art|SOTA|compared to|against)\s+([A-Z][A-Za-z0-9\-_]*)/g;
  const baselines = new Set();
  while ((match = baselinePattern.exec(text)) !== null) {
    if (match[1] && KNOWN_MODELS.has(match[1])) {
      baselines.add(match[1]);
      addEntity(match[1], 'baseline');
    }
  }

  // Now extract relations
  
  // 1. Outperformance relations
  const outperformPatterns = [
    /([A-Z][A-Za-z0-9\-_]*)\s+(?:outperforms?|surpass|exceed|beats|outperform|better than|superior to|outshines?)\s+([A-Z][A-Za-z0-9\-_]*)/g,
    /(?:outperforms|exceeds|better than|surpasses)\s+([A-Z][A-Za-z0-9\-_]*)\s+(?:and|,|on|across|over)\s+([A-Z][A-Za-z0-9\-_]*)/g,
    /([A-Z][A-Za-z0-9\-_]*)\s+improves?\s+(?:over|upon|previous|baseline)\s+([A-Z][A-Za-z0-9\-_]*)/g
  ];

  outperformPatterns.forEach(pattern => {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m[1] && m[2]) {
        addRelation(m[1], 'outperforms', m[2], 0.3, '', 'explicit comparison in abstract');
      }
    }
  });

  // 2. Based-on relations (model architecture/approach foundation)
  const basedonPatterns = [
    /([A-Z][A-Za-z0-9\-_]*)\s+based on\s+([A-Za-z\s]+?)(?:\.|\,|$)/g,
    /based on\s+([A-Za-z\s]+?)\s+([A-Z][A-Za-z0-9\-_]*)/g,
  ];

  basedonPatterns.forEach(pattern => {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m[1] && m[2]) {
        addRelation(m[1], 'is_based_on', m[2], 0.2, '', 'foundation relationship');
      }
    }
  });

  // 3. Uses relations (methodology/technique usage)
  const usesPatterns = [
    /([A-Z][A-Za-z0-9\-_]*)\s+(?:uses?|employs?|applies?|leverages?)\s+([a-z\s]+?)(?:\.|\,|;|$)/g,
    /([a-z\s]+?)\s+(?:for|in)\s+([A-Z][A-Za-z0-9\-_]*)/g
  ];

  usesPatterns.forEach(pattern => {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m[1] && m[2]) {
        addRelation(m[1], 'uses', m[2], 0.2, '', 'methodology usage');
      }
    }
  });

  // 4. Introduces relations (for proposed methods and new concepts)
  const modelArray = Array.from(modelCandidates);
  if (modelArray.length > 0) {
    const primary = modelArray[0];
    if (lower.includes('propose') || lower.includes('introduce') || lower.includes('present')) {
      // This model is introduced in the paper
      if (conceptCandidates.size > 0) {
        const concepts = Array.from(conceptCandidates);
        concepts.slice(0, 3).forEach(concept => {
          addRelation(primary, 'introduces', concept, 0.2, '', 'new technique/approach');
        });
      }
    }
  }

  // 5. Applies-to relations (models applied to tasks/datasets)
  if (modelCandidates.size > 0 && taskCandidates.size > 0) {
    const models = Array.from(modelCandidates);
    const tasks = Array.from(taskCandidates);
    
    // Limit to avoid explosion
    models.slice(0, 2).forEach(model => {
      tasks.slice(0, 2).forEach(task => {
        addRelation(model, 'applies_to', task, 0.2, '', 'application domain');
      });
    });
  }

  // 6. Supersedes relations (if paper mentions improving over prior work)
  if (lower.includes('previous') && modelCandidates.size > 0) {
    const models = Array.from(modelCandidates);
    if (models.length >= 2) {
      addRelation(models[0], 'supersedes', models[1], 0.1, '', 'improvement over prior approach');
    }
  }

  // 7. Enables relations (if technique enables new capability)
  if (conceptCandidates.size > 1) {
    const concepts = Array.from(conceptCandidates);
    for (let i = 0; i < Math.min(concepts.length - 1, 2); i++) {
      addRelation(concepts[i], 'enables', concepts[i + 1], 0.1, '', 'foundational technique');
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
    
    // Extract abstract from prompt
    const abstractMatch = data.prompt.match(/ABSTRACT:\s*([\s\S]*?)\s*(?:STEP|KNOWN)/);
    const abstract = abstractMatch ? abstractMatch[1].trim() : '';
    
    if (!abstract) {
      console.warn(`No abstract found for ${data.arxiv_id}`);
      return;
    }

    const { entities, relations } = extractFromAbstract(data.arxiv_id, data.title, abstract);
    
    output.push(JSON.stringify({
      arxiv_id: data.arxiv_id,
      entities,
      relations
    }));
    
    console.log(`✓ ${data.arxiv_id}: ${entities.length} entities, ${relations.length} relations`);
    
  } catch (e) {
    console.error(`✗ Error:`, e.message);
  }
});

rl.on('close', () => {
  fs.writeFileSync(
    '/Users/vadimr/grafema/enox/data/phase1-raw-batch0.jsonl',
    output.join('\n') + '\n'
  );
  console.log(`\n✓ Processed ${output.length} papers → phase1-raw-batch0.jsonl`);
});
