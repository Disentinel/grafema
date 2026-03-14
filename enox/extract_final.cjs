const fs = require('fs');
const readline = require('readline');

// Comprehensive list of known entities in ML/AI domain
const KNOWN_ENTITIES = {
  models: new Set([
    'TuckER', 'DistMult', 'ComplEx', 'ConvE', 'ConvKB', 'RotatE', 'RESCAL',
    'TransE', 'TransH', 'TransR', 'TransD', 'DKRL', 'KR-EAR',
    'BERT', 'GPT', 'GPT-2', 'GPT-3', 'RoBERTa', 'ELMo', 'XLNet', 'T5', 'ELECTRA',
    'CNN', 'ResNet', 'VGG', 'AlexNet', 'Inception',
    'Transformer', 'Vision Transformer', 'ViT',
    'LSTM', 'GRU', 'Seq2Seq',
    'Word2Vec', 'GloVe', 'FastText',
    'VAE', 'GAN', 'DDPM',
    'BioBERT', 'SciBERT', 'MatBERT',
    'CLIP', 'DALL-E', 'Stable Diffusion',
    'UniLM', 'ERNIE', 'XLM'
  ]),
  datasets: new Set([
    'WN18', 'WN18RR', 'FB15k', 'FB15k-237', 'YAGO', 'Freebase', 'NELL', 'DBpedia',
    'ImageNet', 'MNIST', 'CIFAR-10', 'CIFAR-100', 'STL-10',
    'SQuAD', 'SQuAD v2', 'GLUE', 'SuperGLUE', 'MRPC', 'QQP', 'SST',
    'Wikipedia', 'CommonCrawl', 'BookCorpus', 'CC-News',
    'Penn Treebank', 'OntoNotes', 'CoNLL', 'ACE',
    'UMLS', 'PubMed', 'MEDLINE',
    'MovieLens', 'Amazon Reviews', 'Yelp',
    'MSCOCo', 'Flickr30K', 'Conceptual Captions'
  ]),
  tasks: new Set([
    'link prediction', 'knowledge graph completion',
    'sentiment analysis', 'text classification', 'named entity recognition',
    'machine translation', 'question answering', 'semantic similarity',
    'part-of-speech tagging', 'dependency parsing', 'parsing',
    'image classification', 'object detection', 'semantic segmentation',
    'paraphrase detection', 'textual entailment', 'inference',
    'relation extraction', 'entity linking', 'coreference resolution',
    'machine reading comprehension', 'natural language inference',
    'summarization', 'abstractive summarization', 'extractive summarization',
    'recommendation', 'recommendation system',
    'clustering', 'entity clustering', 'word clustering'
  ]),
  metrics: new Set([
    'accuracy', 'f1', 'f1-score', 'precision', 'recall', 'auc', 'roc', 'pr',
    'bleu', 'rouge', 'meteor', 'perplexity', 'cross-entropy',
    'mrr', 'ndcg', 'map', 'mean reciprocal rank',
    'hits@1', 'hits@3', 'hits@5', 'hits@10',
    'mse', 'mae', 'rmse', 'mape',
    'nmi', 'purity', 'rand index',
    'spearman', 'pearson', 'kendall'
  ]),
  concepts: new Set([
    'embedding', 'representation learning', 'feature learning', 'word embedding',
    'tensor decomposition', 'tensor factorization', 'matrix factorization',
    'neural network', 'deep learning', 'machine learning',
    'attention mechanism', 'self-attention', 'cross-attention', 'multi-head attention',
    'convolutional neural network', 'recurrent neural network', 'rnn',
    'transformer', 'encoder', 'decoder', 'sequence-to-sequence', 'seq2seq',
    'pre-training', 'fine-tuning', 'transfer learning',
    'regularization', 'dropout', 'batch normalization', 'layer normalization',
    'optimization', 'gradient descent', 'backpropagation', 'adam',
    'loss function', 'cross entropy', 'mse loss',
    'knowledge graph', 'semantic web', 'linked data', 'rdf',
    'information extraction', 'knowledge extraction', 'entity extraction',
    'entity resolution', 'record linkage',
    'low-rank approximation', 'dimensionality reduction', 'pca',
    'word sense disambiguation', 'semantic parsing',
    'knowledge distillation', 'neural architecture search'
  ]),
  baselines: new Set([
    'baseline', 'state-of-the-art', 'sota', 'previous methods', 'prior work'
  ])
};

function extractFromAbstract(arxivId, title, abstract) {
  const entities = [];
  const relations = [];
  const entityMap = new Map();
  const seenNames = new Set();

  function addEntity(name, type) {
    if (!name || name.length < 1) return;
    const cleanName = name.trim();
    if (cleanName.length < 2) return;
    
    const key = `${cleanName.toLowerCase()}|${type}`;
    if (!seenNames.has(key)) {
      seenNames.add(key);
      entityMap.set(cleanName, type);
      entities.push({ name: cleanName, type });
    }
  }

  function addRelation(from, rel, to, conf, condition = '', note = '') {
    if (!from || !to || from === to) return;
    if (!entityMap.has(from) || !entityMap.has(to)) return;
    
    relations.push({
      from, rel, to,
      confidence: Math.min(conf, 0.3),
      condition: condition || '',
      note: note || ''
    });
  }

  const text = (abstract + ' ' + title).trim();
  const lower = text.toLowerCase();

  // Extract known models
  KNOWN_ENTITIES.models.forEach(model => {
    if (lower.includes(model.toLowerCase())) {
      addEntity(model, 'model');
    }
  });

  // Extract primary model from title
  const titleFirstWord = title.split(/[:\-\(\)]/)[0].trim().split(/\s+/)[0];
  if (titleFirstWord.match(/^[A-Z]/) && titleFirstWord.length > 2) {
    addEntity(titleFirstWord, 'model');
  }

  // Extract other capitalized proposals
  const proposedPattern = /(?:propose|introduce|present)\s+([A-Z][A-Za-z0-9\-_]*)/g;
  let m;
  while ((m = proposedPattern.exec(text)) !== null) {
    if (m[1] && m[1].length > 2 && !KNOWN_ENTITIES.models.has(m[1])) {
      addEntity(m[1], 'model');
    }
  }

  // Extract known datasets
  KNOWN_ENTITIES.datasets.forEach(dataset => {
    if (lower.includes(dataset.toLowerCase())) {
      addEntity(dataset, 'dataset');
    }
  });

  // Known tasks
  KNOWN_ENTITIES.tasks.forEach(task => {
    if (lower.includes(task.toLowerCase())) {
      addEntity(task, 'task');
    }
  });

  // Known metrics
  KNOWN_ENTITIES.metrics.forEach(metric => {
    if (lower.includes(metric.toLowerCase())) {
      addEntity(metric, 'metric');
    }
  });

  // Known concepts
  KNOWN_ENTITIES.concepts.forEach(concept => {
    if (lower.includes(concept.toLowerCase())) {
      addEntity(concept, 'concept');
    }
  });

  // Extract baseline references
  if (lower.includes('baseline') || lower.includes('sota') || lower.includes('state-of-the-art')) {
    addEntity('baseline', 'baseline');
  }

  // Extract outperformance relations
  const outperfPatterns = [
    /([A-Z][A-Za-z0-9\-_]*)\s+(?:outperforms?|surpass|exceed|beats|show[s]?\s+(?:strong|consistent|significant)\s+improvements?|achieve[s]?\s+(?:better|higher|superior))\s+(?:.*?)\s+([A-Z][A-Za-z0-9\-_]*)/g,
    /outperform[s]?\s+(?:the\s+)?(?:existing|previous|prior|baseline|state-of-the-art)/gi
  ];

  outperfPatterns.forEach(pattern => {
    const m = pattern.exec(text);
    if (m && m[1] && m[2]) {
      addRelation(m[1], 'outperforms', m[2], 0.3, '', 'explicit outperformance claim');
    }
  });

  // Extract is_based_on relations
  const basedonPattern = /([A-Z][A-Za-z0-9\-_]*)\s+(?:based|built|developed|formulated)\s+on\s+([a-z\s]+?)(?:\.|\,|;|\))/gi;
  while ((m = basedonPattern.exec(text)) !== null) {
    if (m[1] && m[2]) {
      const concept = m[2].trim().toLowerCase();
      if (concept.length > 3 && concept.length < 80) {
        addEntity(concept, 'concept');
        addRelation(m[1], 'is_based_on', concept, 0.2, '', 'architectural foundation');
      }
    }
  }

  // Extract uses relations (method uses technique)
  const usesPattern = /(?:uses|employs|leverages|applies|utilizing)\s+(?:the\s+)?([a-z\s]+?)(?:\s+(?:for|to|in|with)|\.|\,|;)/gi;
  while ((m = usesPattern.exec(text)) !== null) {
    if (m[1]) {
      const technique = m[1].trim().toLowerCase();
      if (technique.length > 3 && technique.length < 80) {
        addEntity(technique, 'concept');
      }
    }
  }

  // Extract applies_to relations (model applies to task)
  const models = Array.from(entityMap.entries())
    .filter(([_, type]) => type === 'model')
    .map(([name, _]) => name);
  
  const tasks = Array.from(entityMap.entries())
    .filter(([_, type]) => type === 'task')
    .map(([name, _]) => name);

  if (models.length > 0 && tasks.length > 0) {
    models.forEach(model => {
      tasks.forEach(task => {
        if (lower.includes(task.toLowerCase()) && lower.includes(model.toLowerCase())) {
          addRelation(model, 'applies_to', task, 0.2, '', 'model evaluated on task');
        }
      });
    });
  }

  // Extract introduces relations (paper introduces new method/concept)
  if ((lower.includes('propose') || lower.includes('introduce') || lower.includes('present')) && 
      models.length > 0) {
    const primaryModel = models[0];
    const concepts = Array.from(entityMap.entries())
      .filter(([_, type]) => type === 'concept')
      .map(([name, _]) => name);
    
    concepts.slice(0, 2).forEach(concept => {
      addRelation(primaryModel, 'introduces', concept, 0.2, '', 'novel technique/approach');
    });
  }

  // Extract enables relations between concepts
  const concepts = Array.from(entityMap.entries())
    .filter(([_, type]) => type === 'concept')
    .map(([name, _]) => name);
  
  if (concepts.length >= 2) {
    for (let i = 0; i < Math.min(concepts.length - 1, 2); i++) {
      if (text.includes(concepts[i]) && text.includes(concepts[i + 1])) {
        addRelation(concepts[i], 'enables', concepts[i + 1], 0.1, '', 'foundational technique');
      }
    }
  }

  return { entities, relations };
}

// Main loop
const rl = readline.createInterface({
  input: fs.createReadStream('/Users/vadimr/grafema/enox/data/phase1-prompts-batch0.jsonl'),
  crlfDelay: Infinity
});

const output = [];
let processed = 0;

rl.on('line', (line) => {
  try {
    const data = JSON.parse(line);
    const abstractMatch = data.prompt.match(/ABSTRACT:\s*([\s\S]*?)\s*(?:STEP|KNOWN)/);
    const abstract = abstractMatch ? abstractMatch[1].trim() : '';
    
    if (!abstract) {
      console.warn(`⚠ ${data.arxiv_id}: No abstract found`);
      return;
    }

    const result = extractFromAbstract(data.arxiv_id, data.title, abstract);
    output.push(JSON.stringify({
      arxiv_id: data.arxiv_id,
      entities: result.entities,
      relations: result.relations
    }));
    
    processed++;
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
  console.log(`\n✓ Successfully processed ${processed} papers → phase1-raw-batch0.jsonl`);
});
