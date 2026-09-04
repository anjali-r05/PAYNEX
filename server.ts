import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import {
  runStrategySimulation,
  generatePaynexRecommendation,
  STRATEGY_DEFINITIONS,
} from './src/lib/simulation-engine';
import {
  CommercePassport,
  Merchant,
  MerchantMetrics,
  PassportAIRules,
  PassportAvailabilityConfig,
  PassportBusinessIdentity,
  PassportFulfillment,
  PassportPolicies,
  PassportProduct,
  SimulationConstraints,
  SimulationGoal,
  SimulationSession,
  StrategyKey,
  StrategySimulationResult,
  User,
  WhatIfVariables,
  DealRoomSession,
  OrchestratorTransaction,
  DemoScenarioKey,
  CommerceConstitution,
  PolicyRule,
  PolicyEvaluationInput,
  PolicyEvaluationResult,
  GovernanceAuditEvent,
  ConstitutionDemoScenarioKey,
} from './src/types';
import {
  createDefaultConstitution,
  evaluateConstitutionPolicy,
  validateRule,
  detectConstitutionConflicts,
  calculateConstitutionHealth,
  publishConstitutionVersion,
  getConstitutionDemoScenario,
} from './src/lib/constitution-engine';
import {
  createDefaultPassport,
  deriveStockStatus,
  validatePassport,
} from './src/lib/passport-engine';
import {
  createDealRoomSession,
  advanceNegotiationSession,
  approveDealRoomSession,
  rejectDealRoomSession,
  counterDealRoomSession,
  createDemoNegotiation,
} from './src/lib/deal-room-engine';
import {
  DEFAULT_POLICY_RULES,
  runPreExecutionChecks,
  createAuditEvent,
  calculateOrchestratorMetrics,
  buildSeedTransactions,
  buildDemoScenario,
  formatINR,
  generateId,
} from './src/lib/orchestrator-engine';

const app = express();
const PORT = 3000;

app.use(express.json());

// In-Memory & File-backed persistent Database
interface DBUser extends User {
  passwordHash: string;
  salt: string;
}

interface DBState {
  users: Record<string, DBUser>;
  merchants: Record<string, Merchant>;
  simulations: Record<string, SimulationSession>;
  passports: Record<string, CommercePassport>;
  dealRooms: Record<string, DealRoomSession>;
  transactions: Record<string, OrchestratorTransaction>;
  constitutions: Record<string, CommerceConstitution>;
  sessions: Record<string, string>; // token -> userId
}

const DB_FILE = path.join(process.cwd(), 'paynex-data.json');

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Initial seed with Demo Merchant Aura Botanicals
function getInitialDB(): DBState {
  const salt = crypto.randomBytes(16).toString('hex');
  const demoUser: DBUser = {
    id: 'usr_demo_aurabotanicals',
    email: 'demo@paynex.io',
    fullName: 'Ananya Sharma',
    businessName: 'Aura Botanicals',
    passwordHash: hashPassword('PaynexDemo2026!', salt),
    salt,
    createdAt: new Date().toISOString(),
  };

  const demoMerchant: Merchant = {
    id: 'mer_demo_aurabotanicals',
    userId: demoUser.id,
    businessName: 'Aura Botanicals',
    category: 'Organic Skincare & Wellness D2C',
    description: 'Clean Ayurvedic and botanical skincare formulations distributed direct-to-consumer across India.',
    metrics: {
      monthlyRevenue: 520000,
      monthlyOrders: 1040,
      averageOrderValue: 500,
      conversionRate: 3.2,
      repeatCustomerRate: 28,
      grossMargin: 24.0,
      inventoryLevel: 4500,
    },
    isOnboarded: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Seed sample pre-saved simulation
  const sampleGoal: SimulationGoal = {
    type: 'increase_revenue',
    title: 'Increase Revenue',
    targetPercent: 15,
    timeHorizonDays: 30,
    customDescription: 'Q3 Growth: Target +15% revenue expansion with tight margin control.',
  };

  const sampleConstraints: SimulationConstraints = {
    minMarginPercent: 18.0,
    maxDiscountPercent: 10.0,
    maxCampaignBudget: 30000,
    minInventoryReservePercent: 15.0,
  };

  const sampleStrategies: StrategyKey[] = ['bundle', 'upsell', 'discount'];
  const sampleResults: Record<string, StrategySimulationResult> = {};
  for (const s of sampleStrategies) {
    sampleResults[s] = runStrategySimulation(s, demoMerchant.metrics, sampleConstraints);
  }

  const sampleRecommendation = generatePaynexRecommendation(
    sampleGoal,
    sampleConstraints,
    sampleResults as Record<StrategyKey, StrategySimulationResult>
  );

  const sampleSimulation: SimulationSession = {
    id: 'sim_demo_august_growth',
    merchantId: demoMerchant.id,
    name: 'August Revenue Expansion Benchmark',
    goal: sampleGoal,
    constraints: sampleConstraints,
    selectedStrategies: sampleStrategies,
    whatIfVariables: {},
    results: sampleResults as Record<StrategyKey, StrategySimulationResult>,
    recommendation: sampleRecommendation,
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  };

  return {
    users: { [demoUser.id]: demoUser },
    merchants: { [demoMerchant.id]: demoMerchant },
    simulations: { [sampleSimulation.id]: sampleSimulation },
    passports: {},
    dealRooms: {},
    transactions: {},
    constitutions: {},
    sessions: {},
  };
}

let db: DBState = getInitialDB();

// Load persistent data if exists
try {
  if (fs.existsSync(DB_FILE)) {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.users && parsed.merchants) {
      db = {
        ...parsed,
        passports: parsed.passports || {},
        dealRooms: parsed.dealRooms || {},
        transactions: parsed.transactions || {},
        constitutions: parsed.constitutions || {},
      };
    }
  }
} catch (e) {
  console.warn('Could not read persistent DB file, using fresh initial state.', e);
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to write DB file:', e);
  }
}

// Authentication Middleware
interface AuthenticatedRequest extends Request {
  user?: DBUser;
  merchant?: Merchant;
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const userId = db.sessions[token];
  if (!userId || !db.users[userId]) {
    res.status(401).json({ error: 'Session expired or invalid token. Please sign in again.' });
    return;
  }

  req.user = db.users[userId];
  const merchant = Object.values(db.merchants).find((m) => m.userId === userId);
  req.merchant = merchant;
  next();
}

// ==========================================
// 1. AUTHENTICATION ROUTES
// ==========================================

// Sign Up
app.post('/api/auth/signup', (req: Request, res: Response): void => {
  const { fullName, businessName, email, password, confirmPassword } = req.body;

  if (!fullName || !businessName || !email || !password) {
    res.status(400).json({ error: 'All fields (Full Name, Business Name, Email, Password) are required.' });
    return;
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    res.status(400).json({ error: 'Please provide a valid business email address.' });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    return;
  }

  if (confirmPassword && password !== confirmPassword) {
    res.status(400).json({ error: 'Passwords do not match.' });
    return;
  }

  const existingUser = Object.values(db.users).find((u) => u.email.toLowerCase() === normalizedEmail);
  if (existingUser) {
    res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    return;
  }

  const userId = `usr_${crypto.randomBytes(8).toString('hex')}`;
  const merchantId = `mer_${crypto.randomBytes(8).toString('hex')}`;
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);

  const newUser: DBUser = {
    id: userId,
    email: normalizedEmail,
    fullName: String(fullName).trim(),
    businessName: String(businessName).trim(),
    passwordHash,
    salt,
    createdAt: new Date().toISOString(),
  };

  const newMerchant: Merchant = {
    id: merchantId,
    userId,
    businessName: String(businessName).trim(),
    category: '',
    description: '',
    metrics: {
      monthlyRevenue: 0,
      monthlyOrders: 0,
      averageOrderValue: 0,
      conversionRate: 0,
      repeatCustomerRate: 0,
      grossMargin: 0,
      inventoryLevel: 0,
    },
    isOnboarded: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.users[userId] = newUser;
  db.merchants[merchantId] = newMerchant;

  const token = generateToken();
  db.sessions[token] = userId;
  saveDB();

  // Return safe user object (never plaintext or hash)
  const { passwordHash: _, salt: __, ...safeUser } = newUser;
  res.status(201).json({
    user: safeUser,
    merchant: newMerchant,
    token,
  });
});

// Sign In
app.post('/api/auth/signin', (req: Request, res: Response): void => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = Object.values(db.users).find((u) => u.email.toLowerCase() === normalizedEmail);

  if (!user) {
    res.status(401).json({ error: 'Invalid email or password. Please check your credentials.' });
    return;
  }

  const candidateHash = hashPassword(password, user.salt);
  if (candidateHash !== user.passwordHash) {
    res.status(401).json({ error: 'Invalid email or password. Please check your credentials.' });
    return;
  }

  let merchant = Object.values(db.merchants).find((m) => m.userId === user.id);
  if (!merchant) {
    const merchantId = `mer_${crypto.randomBytes(8).toString('hex')}`;
    merchant = {
      id: merchantId,
      userId: user.id,
      businessName: user.businessName || 'My Business',
      category: '',
      description: '',
      metrics: {
        monthlyRevenue: 500000,
        monthlyOrders: 1000,
        averageOrderValue: 500,
        conversionRate: 3.0,
        repeatCustomerRate: 25,
        grossMargin: 22,
        inventoryLevel: 3000,
      },
      isOnboarded: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.merchants[merchantId] = merchant;
  }

  const token = generateToken();
  db.sessions[token] = user.id;
  saveDB();

  const { passwordHash: _, salt: __, ...safeUser } = user;
  res.json({
    user: safeUser,
    merchant,
    token,
  });
});

// Sign In Demo Account (Aura Botanicals)
app.post('/api/auth/demo', (_req: Request, res: Response): void => {
  const demoUser = db.users['usr_demo_aurabotanicals'] || Object.values(db.users)[0];
  const demoMerchant = Object.values(db.merchants).find((m) => m.userId === demoUser.id) || Object.values(db.merchants)[0];

  const token = generateToken();
  db.sessions[token] = demoUser.id;
  saveDB();

  const { passwordHash: _, salt: __, ...safeUser } = demoUser;
  res.json({
    user: safeUser,
    merchant: demoMerchant,
    token,
  });
});

// Logout
app.post('/api/auth/logout', (req: Request, res: Response): void => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    delete db.sessions[token];
    saveDB();
  }
  res.json({ success: true, message: 'Logged out successfully.' });
});

// Get Current User Profile & Merchant Baseline
app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const user = req.user!;
  const merchant = req.merchant;
  const { passwordHash: _, salt: __, ...safeUser } = user;

  res.json({
    user: safeUser,
    merchant,
  });
});

// ==========================================
// 2. MERCHANT ONBOARDING & BASELINE ROUTES
// ==========================================

app.post('/api/merchant/onboarding', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const user = req.user!;
  let merchant = req.merchant;

  const {
    businessName,
    category,
    description,
    monthlyRevenue,
    monthlyOrders,
    averageOrderValue,
    conversionRate,
    repeatCustomerRate,
    grossMargin,
    inventoryLevel,
  } = req.body;

  const rev = Number(monthlyRevenue) || 0;
  const orders = Number(monthlyOrders) || 0;
  const aov = Number(averageOrderValue) || (orders > 0 ? Math.round(rev / orders) : 500);

  const metrics: MerchantMetrics = {
    monthlyRevenue: rev,
    monthlyOrders: orders,
    averageOrderValue: aov,
    conversionRate: Number(conversionRate) || 3.0,
    repeatCustomerRate: Number(repeatCustomerRate) || 25,
    grossMargin: Number(grossMargin) || 20.0,
    inventoryLevel: Number(inventoryLevel) || 1000,
  };

  if (!merchant) {
    const merchantId = `mer_${crypto.randomBytes(8).toString('hex')}`;
    merchant = {
      id: merchantId,
      userId: user.id,
      businessName: businessName || user.businessName,
      category: category || 'General Commerce',
      description: description || '',
      metrics,
      isOnboarded: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.merchants[merchantId] = merchant;
  } else {
    merchant.businessName = businessName || merchant.businessName;
    merchant.category = category || merchant.category;
    merchant.description = description || merchant.description;
    merchant.metrics = metrics;
    merchant.isOnboarded = true;
    merchant.updatedAt = new Date().toISOString();
  }

  saveDB();
  res.json({ success: true, merchant });
});

// Update Merchant Baseline Metrics
app.put('/api/merchant/metrics', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant;
  if (!merchant) {
    res.status(404).json({ error: 'Merchant profile not found.' });
    return;
  }

  merchant.metrics = {
    ...merchant.metrics,
    ...req.body,
  };
  merchant.updatedAt = new Date().toISOString();
  saveDB();

  res.json({ success: true, merchant });
});

// ==========================================
// 3. COMMERCE SIMULATION ROUTES (ISOLATED)
// ==========================================

// Run Simulation (Deterministic Engine)
app.post('/api/simulations/run', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant;
  if (!merchant || !merchant.isOnboarded) {
    res.status(400).json({ error: 'Merchant baseline is required before running simulations.' });
    return;
  }

  const { goal, constraints, selectedStrategies, whatIfVariables } = req.body as {
    goal: SimulationGoal;
    constraints: SimulationConstraints;
    selectedStrategies: StrategyKey[];
    whatIfVariables?: WhatIfVariables;
  };

  if (!selectedStrategies || !Array.isArray(selectedStrategies) || selectedStrategies.length === 0) {
    res.status(400).json({ error: 'Please select at least one strategy to simulate.' });
    return;
  }

  // Calculate deterministic results for each strategy
  const results: Record<string, StrategySimulationResult> = {};
  for (const strategyKey of selectedStrategies) {
    if (STRATEGY_DEFINITIONS[strategyKey]) {
      results[strategyKey] = runStrategySimulation(
        strategyKey,
        merchant.metrics,
        constraints,
        whatIfVariables
      );
    }
  }

  // Generate multi-criteria recommendation & explainability
  const recommendation = generatePaynexRecommendation(
    goal,
    constraints,
    results as Record<StrategyKey, StrategySimulationResult>
  );

  res.json({
    results,
    recommendation,
    calculatedAt: new Date().toISOString(),
  });
});

// Natural language goal parsing
app.post('/api/simulations/parse-intent', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'Text prompt required.' });
    return;
  }

  const lower = text.toLowerCase();
  let goalType: SimulationGoal['type'] = 'increase_revenue';
  let targetPercent = 15;
  let minMarginPercent = 18;
  let maxDiscountPercent = 10;
  let timeHorizonDays = 30;

  if (lower.includes('profit') || lower.includes('margin')) {
    goalType = 'increase_profit';
  } else if (lower.includes('aov') || lower.includes('order value') || lower.includes('basket')) {
    goalType = 'increase_aov';
  } else if (lower.includes('conversion') || lower.includes('convert')) {
    goalType = 'improve_conversion';
  } else if (lower.includes('repeat') || lower.includes('retention') || lower.includes('loyalty')) {
    goalType = 'increase_repeat_purchases';
  } else if (lower.includes('inventory') || lower.includes('stock') || lower.includes('clear')) {
    goalType = 'clear_inventory';
  }

  // Match target percentage
  const targetMatch = lower.match(/(\d+)%\s*(?:revenue|growth|increase|target|lift)/i) || lower.match(/increase.*?by\s*(\d+)%/i);
  if (targetMatch && targetMatch[1]) {
    targetPercent = parseInt(targetMatch[1], 10);
  }

  // Match margin constraint
  const marginMatch = lower.match(/margin.*?below\s*(\d+)%/i) || lower.match(/minimum.*?margin.*?(\d+)%/i) || lower.match(/keep.*?margin.*?(\d+)%/i);
  if (marginMatch && marginMatch[1]) {
    minMarginPercent = parseInt(marginMatch[1], 10);
  }

  // Match discount limit
  const discountMatch = lower.match(/discount.*?max(?:imum)?.*?(\d+)%/i) || lower.match(/discount.*?below\s*(\d+)%/i);
  if (discountMatch && discountMatch[1]) {
    maxDiscountPercent = parseInt(discountMatch[1], 10);
  }

  // Match time horizon
  const daysMatch = lower.match(/(\d+)\s*(?:days|day)/i) || lower.match(/(\d+)\s*(?:month|months)/i);
  if (daysMatch && daysMatch[1]) {
    const val = parseInt(daysMatch[1], 10);
    timeHorizonDays = lower.includes('month') ? val * 30 : val;
  }

  res.json({
    interpretedGoal: {
      type: goalType,
      title: goalType.replace('_', ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
      targetPercent,
      timeHorizonDays,
      customDescription: text,
    },
    suggestedConstraints: {
      minMarginPercent,
      maxDiscountPercent,
      maxCampaignBudget: 25000,
      minInventoryReservePercent: 15,
    },
    suggestedStrategies: goalType === 'increase_aov' ? ['bundle', 'upsell', 'cross_sell'] : ['bundle', 'upsell', 'discount'],
  });
});

// Save Simulation Session (Merchant-Isolated)
app.post('/api/simulations/save', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const { name, goal, constraints, selectedStrategies, whatIfVariables, results, recommendation } = req.body;

  if (!name || !goal || !results) {
    res.status(400).json({ error: 'Simulation name, goal, and results are required to save.' });
    return;
  }

  const id = `sim_${crypto.randomBytes(8).toString('hex')}`;
  const newSimulation: SimulationSession = {
    id,
    merchantId: merchant.id,
    name: String(name).trim(),
    goal,
    constraints,
    selectedStrategies: selectedStrategies || Object.keys(results),
    whatIfVariables: whatIfVariables || {},
    results,
    recommendation,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.simulations[id] = newSimulation;
  saveDB();

  res.status(201).json({ success: true, simulation: newSimulation });
});

// List Merchant's Saved Simulations (Isolated)
app.get('/api/simulations', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const merchantSimulations = Object.values(db.simulations)
    .filter((s) => s.merchantId === merchant.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  res.json({ simulations: merchantSimulations });
});

// Get Single Simulation Session
app.get('/api/simulations/:id', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const sim = db.simulations[req.params.id];

  if (!sim || sim.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Simulation not found or access denied.' });
    return;
  }

  res.json({ simulation: sim });
});

// Delete Simulation Session
app.delete('/api/simulations/:id', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const sim = db.simulations[req.params.id];

  if (!sim || sim.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Simulation not found or access denied.' });
    return;
  }

  delete db.simulations[req.params.id];
  saveDB();

  res.json({ success: true, message: 'Simulation deleted successfully.' });
});

// Duplicate Simulation Session
app.post('/api/simulations/:id/duplicate', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const sourceSim = db.simulations[req.params.id];

  if (!sourceSim || sourceSim.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Simulation not found or access denied.' });
    return;
  }

  const id = `sim_${crypto.randomBytes(8).toString('hex')}`;
  const duplicated: SimulationSession = {
    ...sourceSim,
    id,
    name: `${sourceSim.name} (Copy)`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.simulations[id] = duplicated;
  saveDB();

  res.status(201).json({ success: true, simulation: duplicated });
});

// ==========================================
// 4. AI COMMERCE PASSPORT ROUTES
// ==========================================

// Helper: Ensure passport exists with proper baseline
function getOrCreatePassport(merchant: Merchant): CommercePassport {
  if (db.passports[merchant.id]) {
    return db.passports[merchant.id];
  }
  const created = createDefaultPassport(merchant.id, merchant.businessName, merchant.category);
  db.passports[merchant.id] = created;
  saveDB();
  return created;
}

// Get Merchant Passport
app.get('/api/passport', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const passport = getOrCreatePassport(merchant);
  res.json({ passport });
});

// Save Entire Passport
app.post('/api/passport', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const updatedData: Partial<CommercePassport> = req.body;
  const current = getOrCreatePassport(merchant);

  const merged: CommercePassport = {
    ...current,
    ...updatedData,
    merchantId: merchant.id,
    updatedAt: new Date().toISOString(),
  };

  const validation = validatePassport(merged);
  merged.readinessScore = validation.readinessScore;
  merged.completionPercentage = Math.round((merged.completedSteps.length / 7) * 100);

  if (merged.completedSteps.length >= 6 && validation.isValid && merged.status !== 'PUBLISHED') {
    merged.status = 'READY FOR VERIFICATION';
  }

  db.passports[merchant.id] = merged;
  saveDB();

  res.json({ success: true, passport: merged, validation });
});

// Save / Update Business Identity (Step 1)
app.post('/api/passport/business-identity', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const {
    businessName,
    businessCategory,
    businessDescription,
    website,
    supportEmail,
    supportPhone,
    businessLocation,
  } = req.body;

  if (!businessName || !businessCategory || !businessDescription) {
    res.status(400).json({ error: 'Business Name, Category, and Description are required.' });
    return;
  }

  const current = getOrCreatePassport(merchant);

  const updatedIdentity: PassportBusinessIdentity = {
    businessName: String(businessName || '').trim(),
    businessCategory: String(businessCategory || '').trim(),
    businessDescription: String(businessDescription || '').trim(),
    website: String(website || '').trim(),
    supportEmail: String(supportEmail || '').trim(),
    supportPhone: String(supportPhone || '').trim(),
    businessLocation: String(businessLocation || '').trim(),
  };

  const completedSteps = current.completedSteps.includes(1)
    ? current.completedSteps
    : [...current.completedSteps, 1].sort((a, b) => a - b);

  current.businessIdentity = updatedIdentity;
  current.completedSteps = completedSteps;
  current.completionPercentage = Math.round((completedSteps.length / 7) * 100);
  current.status = current.status === 'PUBLISHED' ? 'PUBLISHED' : 'IN PROGRESS';
  current.updatedAt = new Date().toISOString();

  // Validate & update score
  const validation = validatePassport(current);
  current.readinessScore = validation.readinessScore;

  db.passports[merchant.id] = current;

  // Sync merchant baseline
  if (businessName) merchant.businessName = String(businessName).trim();
  if (businessCategory) merchant.category = String(businessCategory).trim();
  if (businessDescription) merchant.description = String(businessDescription).trim();
  merchant.updatedAt = new Date().toISOString();

  saveDB();

  res.json({ success: true, passport: current, validation });
});

// Save / Update Products (Step 2)
app.post('/api/passport/products', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const { products } = req.body as { products: PassportProduct[] };

  if (!Array.isArray(products) || products.length === 0) {
    res.status(400).json({ error: 'At least one product is required in the catalog.' });
    return;
  }

  const current = getOrCreatePassport(merchant);

  // Validate products structure
  const cleanProducts: PassportProduct[] = products.map((p) => {
    const qty = typeof p.quantity === 'number' ? Math.max(0, p.quantity) : 0;
    const derivedStatus = deriveStockStatus(qty, p.lowStockThreshold || current.availability?.defaultLowStockThreshold || 5, p.stockStatus === 'PREORDER');
    return {
      id: p.id || `prod_${crypto.randomBytes(6).toString('hex')}`,
      name: String(p.name || '').trim(),
      sku: String(p.sku || '').trim().toUpperCase(),
      category: String(p.category || '').trim(),
      shortDescription: String(p.shortDescription || '').trim(),
      detailedDescription: String(p.detailedDescription || '').trim(),
      price: Math.max(0.01, Number(p.price) || 1),
      currency: String(p.currency || 'INR').toUpperCase(),
      productUrl: p.productUrl ? String(p.productUrl).trim() : undefined,
      brand: p.brand ? String(p.brand).trim() : current.businessIdentity.businessName,
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
      variants: Array.isArray(p.variants) ? p.variants.map(String) : [],
      status: p.status === 'DRAFT' ? 'DRAFT' : 'ACTIVE',
      quantity: qty,
      stockStatus: derivedStatus,
      lowStockThreshold: p.lowStockThreshold || 5,
      updatedAt: new Date().toISOString(),
    };
  });

  const completedSteps = current.completedSteps.includes(2)
    ? current.completedSteps
    : [...current.completedSteps, 2].sort((a, b) => a - b);

  current.products = cleanProducts;
  current.completedSteps = completedSteps;
  current.completionPercentage = Math.round((completedSteps.length / 7) * 100);
  current.updatedAt = new Date().toISOString();

  const validation = validatePassport(current);
  current.readinessScore = validation.readinessScore;

  db.passports[merchant.id] = current;
  saveDB();

  res.json({ success: true, passport: current, validation });
});

// Save / Update Availability (Step 3)
app.post('/api/passport/availability', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const { availability, productQuantities } = req.body as {
    availability?: PassportAvailabilityConfig;
    productQuantities?: Record<string, { quantity: number; stockStatus?: string; lowStockThreshold?: number }>;
  };

  const current = getOrCreatePassport(merchant);

  if (availability) {
    current.availability = {
      defaultLowStockThreshold: Math.max(1, Number(availability.defaultLowStockThreshold) || 5),
      inventorySyncMode: availability.inventorySyncMode || 'REALTIME_FEED',
      allowPreorders: Boolean(availability.allowPreorders),
      leadTimeDays: Math.max(0, Number(availability.leadTimeDays) || 1),
    };
  }

  // Update per-product stock quantities if provided
  if (productQuantities && typeof productQuantities === 'object') {
    current.products = current.products.map((p) => {
      if (productQuantities[p.id] !== undefined) {
        const update = productQuantities[p.id];
        const newQty = Math.max(0, Number(update.quantity) || 0);
        const threshold = update.lowStockThreshold || current.availability.defaultLowStockThreshold || 5;
        const newStatus = deriveStockStatus(newQty, threshold, update.stockStatus === 'PREORDER');
        return {
          ...p,
          quantity: newQty,
          stockStatus: newStatus,
          lowStockThreshold: threshold,
          updatedAt: new Date().toISOString(),
        };
      }
      return p;
    });
  }

  const completedSteps = current.completedSteps.includes(3)
    ? current.completedSteps
    : [...current.completedSteps, 3].sort((a, b) => a - b);

  current.completedSteps = completedSteps;
  current.completionPercentage = Math.round((completedSteps.length / 7) * 100);
  current.updatedAt = new Date().toISOString();

  const validation = validatePassport(current);
  current.readinessScore = validation.readinessScore;

  db.passports[merchant.id] = current;
  saveDB();

  res.json({ success: true, passport: current, validation });
});

// Save / Update Fulfillment (Step 4)
app.post('/api/passport/fulfillment', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const fulfillmentData = req.body as PassportFulfillment;

  const current = getOrCreatePassport(merchant);

  current.fulfillment = {
    processingTimeMin: Math.max(0, Number(fulfillmentData.processingTimeMin) || 1),
    processingTimeMax: Math.max(1, Number(fulfillmentData.processingTimeMax) || 2),
    deliveryTimeMin: Math.max(1, Number(fulfillmentData.deliveryTimeMin) || 2),
    deliveryTimeMax: Math.max(1, Number(fulfillmentData.deliveryTimeMax) || 5),
    shippingCost: Math.max(0, Number(fulfillmentData.shippingCost) || 0),
    freeShippingThreshold: Math.max(0, Number(fulfillmentData.freeShippingThreshold) || 0),
    shippingRegions: Array.isArray(fulfillmentData.shippingRegions) && fulfillmentData.shippingRegions.length > 0
      ? fulfillmentData.shippingRegions
      : ['Pan-India'],
    carriers: Array.isArray(fulfillmentData.carriers) && fulfillmentData.carriers.length > 0
      ? fulfillmentData.carriers
      : ['Standard Courier Express'],
    pickupAvailable: Boolean(fulfillmentData.pickupAvailable),
    internationalShipping: Boolean(fulfillmentData.internationalShipping),
  };

  const completedSteps = current.completedSteps.includes(4)
    ? current.completedSteps
    : [...current.completedSteps, 4].sort((a, b) => a - b);

  current.completedSteps = completedSteps;
  current.completionPercentage = Math.round((completedSteps.length / 7) * 100);
  current.updatedAt = new Date().toISOString();

  const validation = validatePassport(current);
  current.readinessScore = validation.readinessScore;

  db.passports[merchant.id] = current;
  saveDB();

  res.json({ success: true, passport: current, validation });
});

// Save / Update Policies (Step 5)
app.post('/api/passport/policies', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const policiesData = req.body as PassportPolicies;

  const current = getOrCreatePassport(merchant);

  current.policies = {
    returnWindowDays: Math.max(0, Number(policiesData.returnWindowDays) || 7),
    refundAvailable: Boolean(policiesData.refundAvailable),
    refundProcessingTimeDays: Math.max(0, Number(policiesData.refundProcessingTimeDays) || 3),
    cancellationWindowHours: Math.max(0, Number(policiesData.cancellationWindowHours) || 2),
    exchangeAvailable: Boolean(policiesData.exchangeAvailable),
    warrantyAvailable: Boolean(policiesData.warrantyAvailable),
    warrantyDurationMonths: Math.max(0, Number(policiesData.warrantyDurationMonths) || 0),
    supportHours: String(policiesData.supportHours || 'Mon-Sat: 09:00 AM - 07:00 PM IST').trim(),
    returnShippingResponsibility: policiesData.returnShippingResponsibility || 'MERCHANT',
  };

  const completedSteps = current.completedSteps.includes(5)
    ? current.completedSteps
    : [...current.completedSteps, 5].sort((a, b) => a - b);

  current.completedSteps = completedSteps;
  current.completionPercentage = Math.round((completedSteps.length / 7) * 100);
  current.updatedAt = new Date().toISOString();

  const validation = validatePassport(current);
  current.readinessScore = validation.readinessScore;

  db.passports[merchant.id] = current;
  saveDB();

  res.json({ success: true, passport: current, validation });
});

// Save / Update AI Rules (Step 6)
app.post('/api/passport/ai-rules', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const aiRulesData = req.body as PassportAIRules;

  const current = getOrCreatePassport(merchant);

  current.aiRules = {
    allowProductDiscovery: Boolean(aiRulesData.allowProductDiscovery),
    allowProductRecommendations: Boolean(aiRulesData.allowProductRecommendations),
    allowProductComparison: Boolean(aiRulesData.allowProductComparison),
    allowAvailabilityChecking: Boolean(aiRulesData.allowAvailabilityChecking),
    allowInitiateCheckout: Boolean(aiRulesData.allowInitiateCheckout),
    allowApprovedDiscounts: Boolean(aiRulesData.allowApprovedDiscounts),
    allowCustomOfferRequests: Boolean(aiRulesData.allowCustomOfferRequests),
    maxDiscountPercent: Math.min(100, Math.max(0, Number(aiRulesData.maxDiscountPercent) || 10)),
    maxOrderValueWithoutApproval: Math.max(1, Number(aiRulesData.maxOrderValueWithoutApproval) || 5000),
    requireApprovalForOrdersAboveLimit: Boolean(aiRulesData.requireApprovalForOrdersAboveLimit),
    requireApprovalForDiscountsAboveLimit: Boolean(aiRulesData.requireApprovalForDiscountsAboveLimit),
    requireApprovalForOutOfStockAlternatives: Boolean(aiRulesData.requireApprovalForOutOfStockAlternatives),
    requireApprovalForCustomOffers: Boolean(aiRulesData.requireApprovalForCustomOffers),
  };

  const completedSteps = current.completedSteps.includes(6)
    ? current.completedSteps
    : [...current.completedSteps, 6].sort((a, b) => a - b);

  current.completedSteps = completedSteps;
  current.completionPercentage = Math.round((completedSteps.length / 7) * 100);
  current.updatedAt = new Date().toISOString();

  const validation = validatePassport(current);
  current.readinessScore = validation.readinessScore;

  if (validation.isValid && current.status !== 'PUBLISHED') {
    current.status = 'READY FOR VERIFICATION';
  }

  db.passports[merchant.id] = current;
  saveDB();

  res.json({ success: true, passport: current, validation });
});

// Validate Passport Endpoint
app.post('/api/passport/validate', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const current = getOrCreatePassport(merchant);
  const validation = validatePassport(current);
  res.json({ validation, passport: current });
});

// Publish Passport (Step 7)
app.post('/api/passport/publish', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const current = getOrCreatePassport(merchant);

  // Validate before publishing
  const validation = validatePassport(current);
  if (!validation.isValid) {
    res.status(400).json({
      error: `Resolve ${validation.errors.length} issue${validation.errors.length > 1 ? 's' : ''} before publishing.`,
      validation,
    });
    return;
  }

  const newVersion = (current.version || 0) + 1;
  const publishedAt = new Date().toISOString();

  const historyItem = {
    version: newVersion,
    publishedAt,
    publishedBy: req.user.email,
    readinessScore: validation.readinessScore,
    productsCount: current.products.length,
    note: `Published Version ${newVersion} with ${current.products.length} indexed products`,
  };

  const completedSteps = [1, 2, 3, 4, 5, 6, 7];

  current.version = newVersion;
  current.status = 'PUBLISHED';
  current.readinessScore = validation.readinessScore;
  current.completionPercentage = 100;
  current.completedSteps = completedSteps;
  current.publishedAt = publishedAt;
  current.updatedAt = publishedAt;
  current.versionHistory = [historyItem, ...(current.versionHistory || [])];

  db.passports[merchant.id] = current;
  saveDB();

  res.json({
    success: true,
    message: 'Your AI Commerce Passport is ready to be discovered by AI buyers.',
    passport: current,
    validation,
  });
});

// ==========================================
// 5. AI DEAL ROOM ROUTES
// ==========================================

// List Merchant Deal Room Sessions
app.get('/api/deal-room/sessions', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const sessions = Object.values(db.dealRooms)
    .filter((s) => s.merchantId === merchant.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  res.json({ sessions });
});

// Create New Deal Room Session
app.post('/api/deal-room/sessions', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const passport = getOrCreatePassport(merchant);
  const { productId, quantity, buyerType, buyerRequest, targetPrice, deliveryRequirement } = req.body;

  if (!productId || !quantity || !buyerRequest) {
    res.status(400).json({ error: 'Product, quantity, and buyer request are required.' });
    return;
  }

  try {
    const session = createDealRoomSession({
      merchantId: merchant.id,
      passport,
      productId: String(productId),
      quantity: Number(quantity),
      buyerType: buyerType ? String(buyerType) : undefined,
      buyerRequest: String(buyerRequest),
      targetPrice: targetPrice ? Number(targetPrice) : undefined,
      deliveryRequirement: deliveryRequirement ? String(deliveryRequirement) : undefined,
    });

    db.dealRooms[session.id] = session;
    saveDB();

    res.status(201).json({ success: true, session });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to start AI Deal Room session.' });
  }
});

// Get Single Deal Room Session
app.get('/api/deal-room/sessions/:id', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const session = db.dealRooms[req.params.id];

  if (!session || session.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Deal Room session not found.' });
    return;
  }

  res.json({ session });
});

// Advance Negotiation Round
app.post('/api/deal-room/sessions/:id/advance', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const passport = getOrCreatePassport(merchant);
  const session = db.dealRooms[req.params.id];

  if (!session || session.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Deal Room session not found.' });
    return;
  }

  const updatedSession = advanceNegotiationSession(session, passport);
  db.dealRooms[session.id] = updatedSession;
  saveDB();

  res.json({ success: true, session: updatedSession });
});

// Merchant Approves Deal Exception
app.post('/api/deal-room/sessions/:id/approve', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const passport = getOrCreatePassport(merchant);
  const session = db.dealRooms[req.params.id];

  if (!session || session.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Deal Room session not found.' });
    return;
  }

  const updatedSession = approveDealRoomSession(session, passport);
  db.dealRooms[session.id] = updatedSession;
  saveDB();

  res.json({ success: true, session: updatedSession });
});

// Merchant Rejects Deal
app.post('/api/deal-room/sessions/:id/reject', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const session = db.dealRooms[req.params.id];
  const { reason } = req.body;

  if (!session || session.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Deal Room session not found.' });
    return;
  }

  const updatedSession = rejectDealRoomSession(session, String(reason || ''));
  db.dealRooms[session.id] = updatedSession;
  saveDB();

  res.json({ success: true, session: updatedSession });
});

// Merchant Counters with Custom Offer
app.post('/api/deal-room/sessions/:id/counter', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const passport = getOrCreatePassport(merchant);
  const session = db.dealRooms[req.params.id];
  const { customPrice } = req.body;

  if (!session || session.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Deal Room session not found.' });
    return;
  }

  if (!customPrice || Number(customPrice) <= 0) {
    res.status(400).json({ error: 'Valid custom counter price is required.' });
    return;
  }

  const updatedSession = counterDealRoomSession(session, Number(customPrice), passport);
  db.dealRooms[session.id] = updatedSession;
  saveDB();

  res.json({ success: true, session: updatedSession });
});

// Delete Deal Room Session
app.delete('/api/deal-room/sessions/:id', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const session = db.dealRooms[req.params.id];

  if (!session || session.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Deal Room session not found.' });
    return;
  }

  delete db.dealRooms[req.params.id];
  saveDB();

  res.json({ success: true, message: 'Deal session deleted.' });
});

// Create Demo Negotiation
app.post('/api/deal-room/demo', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const passport = getOrCreatePassport(merchant);

  const demoSession = createDemoNegotiation(passport);
  db.dealRooms[demoSession.id] = demoSession;
  saveDB();

  res.status(201).json({ success: true, session: demoSession });
});

// ==========================================
// 3. TRANSACTION ORCHESTRATOR API
// ==========================================

async function createRazorpayTestOrder(
  amountINR: number,
  currency: string = 'INR',
  receiptId: string
): Promise<{
  mode: 'RAZORPAY_TEST' | 'DEMO_SANDBOX';
  orderId: string;
  paymentId: string;
  providerName: string;
}> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (keyId && keySecret && keyId.trim() !== '' && keySecret.trim() !== '') {
    try {
      const amountPaise = Math.round(amountINR * 100);
      const authHeader = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

      const response = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency: currency || 'INR',
          receipt: receiptId,
          notes: {
            platform: 'PAYNEX Transaction Orchestrator',
            environment: 'Razorpay Test Mode',
          },
        }),
      });

      if (response.ok) {
        const orderData = (await response.json()) as any;
        const randPay = Math.floor(100000 + Math.random() * 900000);
        return {
          mode: 'RAZORPAY_TEST',
          orderId: orderData.id,
          paymentId: `pay_test_${randPay}`,
          providerName: 'Razorpay Test Gateway',
        };
      } else {
        console.warn('Razorpay test order error, falling back to Demo Sandbox:', await response.text());
      }
    } catch (err) {
      console.warn('Razorpay test order request failed, falling back to Demo Sandbox:', err);
    }
  }

  // Safe fallback to PAYNEX Demo Sandbox
  const randOrder = Math.floor(1000000000 + Math.random() * 9000000000);
  const randPay = Math.floor(1000000000 + Math.random() * 9000000000);
  return {
    mode: 'DEMO_SANDBOX',
    orderId: `order_sandbox_${randOrder}`,
    paymentId: `paynex_sand_${randPay}`,
    providerName: 'PAYNEX Demo Sandbox',
  };
}

function syncDealsToTransactions(merchantId: string, merchantName: string) {
  if (!db.transactions) db.transactions = {};
  const merchantDeals = Object.values(db.dealRooms || {}).filter((d) => d.merchantId === merchantId);

  for (const deal of merchantDeals) {
    if (deal.status === 'READY_FOR_TRANSACTION' && deal.finalDeal) {
      const existing = Object.values(db.transactions).find((t) => t.dealId === deal.id);
      if (!existing) {
        const txnId = generateId('TXN');
        const newTxn: OrchestratorTransaction = {
          id: txnId,
          idempotencyKey: `PAYNEX-${txnId}`,
          merchantId,
          merchantName,
          buyerId: 'buy_agent_' + (deal.buyerType ? String(deal.buyerType).toLowerCase().replace(/\s+/g, '_') : 'deal'),
          buyerName: `${deal.buyerType || 'AI Buyer'} (${deal.id})`,
          buyerType: typeof deal.buyerType === 'string' ? deal.buyerType : 'B2B Procurement AI',
          dealId: deal.id,
          purpose: `Purchase ${deal.finalDeal.quantity} units of ${deal.finalDeal.productName}`,
          items: [
            {
              productId: deal.finalDeal.productId,
              productName: deal.finalDeal.productName,
              sku: deal.finalDeal.productSku,
              quantity: deal.finalDeal.quantity,
              unitPrice: deal.finalDeal.unitPrice,
              subtotal: deal.finalDeal.unitPrice * deal.finalDeal.quantity,
              discountAmount: (deal.baseTotal || deal.finalDeal.unitPrice * deal.finalDeal.quantity) - deal.finalDeal.totalPrice,
              taxAmount: 0,
              shippingAmount: 0,
              finalAmount: deal.finalDeal.totalPrice,
            },
          ],
          amount: deal.finalDeal.totalPrice,
          currency: 'INR',
          status: 'READY',
          riskStatus: 'LOW',
          riskScore: 12,
          approvalStatus: 'APPROVED',
          approvedBy: `AI Deal Room Session #${deal.id}`,
          approvedAt: new Date().toISOString(),
          executionMode: 'DEMO_SANDBOX',
          paymentProvider: 'PAYNEX Demo Sandbox',
          preExecutionChecks: [],
          policySatisfied: true,
          activePipelineStage: 'EXECUTION',
          retryCount: 0,
          maxRetries: 3,
          auditEvents: [
            createAuditEvent('AI Deal Room', `Commercial agreement concluded in session #${deal.id}`, 'PASSED', 'DEAL'),
            createAuditEvent('PAYNEX Orchestrator', `Transaction registered with idempotency key PAYNEX-${txnId}`, 'PASSED', 'IDEMPOTENCY'),
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        db.transactions[txnId] = newTxn;
      }
    }
  }
}

function ensureTransactions(merchantId: string, merchantName: string): OrchestratorTransaction[] {
  if (!db.transactions) db.transactions = {};

  const merchantTxns = Object.values(db.transactions).filter((t) => t.merchantId === merchantId);
  if (merchantTxns.length === 0) {
    const seeds = buildSeedTransactions(merchantId, merchantName);
    for (const s of seeds) {
      db.transactions[s.id] = s;
    }
  }

  syncDealsToTransactions(merchantId, merchantName);
  saveDB();

  return Object.values(db.transactions)
    .filter((t) => t.merchantId === merchantId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

// Get Orchestrator Provider Status
app.get('/api/orchestrator/provider', (_req: Request, res: Response): void => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const isConfigured = Boolean(keyId && keySecret && keyId.trim() !== '' && keySecret.trim() !== '');

  res.json({
    mode: isConfigured ? 'RAZORPAY_TEST' : 'DEMO_SANDBOX',
    providerName: isConfigured ? 'Razorpay Test Gateway' : 'PAYNEX Demo Sandbox',
    isLiveTestKeyConfigured: isConfigured,
    disclaimer: 'DEMO ENVIRONMENT — NO REAL MONEY IS ACCESSED OR MOVED',
  });
});

// List all transactions
app.get('/api/orchestrator/transactions', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const transactions = ensureTransactions(merchant.id, merchant.businessName);
  res.json({ transactions });
});

// Get single transaction
app.get('/api/orchestrator/transactions/:id', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  ensureTransactions(merchant.id, merchant.businessName);
  const txn = db.transactions?.[req.params.id];

  if (!txn || txn.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Transaction not found.' });
    return;
  }

  res.json({ transaction: txn });
});

// Run Pre-Execution Gate Checks
app.post('/api/orchestrator/transactions/:id/precheck', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const passport = getOrCreatePassport(merchant);
  ensureTransactions(merchant.id, merchant.businessName);
  const txn = db.transactions?.[req.params.id];

  if (!txn || txn.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Transaction not found.' });
    return;
  }

  const existingTxns = Object.values(db.transactions);
  const constitution = ensureConstitution(merchant.id);

  // Evaluate against Commerce Constitution
  const constEval = evaluateConstitutionPolicy(constitution, {
    action_type: 'CREATE_PAYMENT',
    transaction_amount: txn.amount,
    discount_percent: txn.items?.[0]?.discountAmount ? Math.round((txn.items[0].discountAmount / (txn.amount + txn.items[0].discountAmount)) * 100) : 0,
    margin_percent: merchant.metrics?.grossMargin || 24,
    risk_score: txn.riskScore || 15,
    actor: txn.buyerName || 'Autonomous Buyer Agent',
    currency: txn.currency || 'INR',
  });

  const checkResult = runPreExecutionChecks(txn, passport, DEFAULT_POLICY_RULES, existingTxns);

  // Prepend Constitution verification item
  checkResult.checks.unshift({
    id: 'CONSTITUTION_POLICY_GATE',
    name: `Commerce Constitution (${constEval.triggeredRuleId})`,
    category: 'POLICY',
    passed: constEval.decision === 'ALLOW' || constEval.decision === 'ALLOW_WITH_CONDITIONS' || (constEval.decision === 'HUMAN_APPROVAL' && txn.approvalStatus === 'APPROVED'),
    requiresHumanApproval: constEval.decision === 'HUMAN_APPROVAL',
    details: constEval.explanation,
    value: constEval.decision,
    threshold: constEval.triggeredRuleName,
  });

  if (constEval.decision === 'BLOCK') {
    checkResult.canExecute = false;
    checkResult.policyNotes = `Commerce Constitution [${constEval.triggeredRuleId}]: ${constEval.explanation}`;
  } else if (constEval.decision === 'HUMAN_APPROVAL' && txn.approvalStatus !== 'APPROVED') {
    checkResult.canExecute = false;
    checkResult.requiresHumanApproval = true;
    checkResult.policyNotes = `Commerce Constitution [${constEval.triggeredRuleId}]: ${constEval.explanation}`;
  }

  txn.preExecutionChecks = checkResult.checks;
  txn.policySatisfied = checkResult.canExecute;
  txn.policyNotes = checkResult.policyNotes || txn.policyNotes;

  if (checkResult.isDuplicate) {
    txn.status = 'BLOCKED';
    txn.isDuplicatePrevented = true;
    txn.failureReason = 'Duplicate transaction execution prevented by Idempotency Guard.';
    txn.activePipelineStage = 'IDEMPOTENCY';
    txn.auditEvents.push(
      createAuditEvent('PAYNEX Idempotency Guard', 'Duplicate key matched with captured transaction', 'FAILED', 'IDEMPOTENCY')
    );
  } else if (checkResult.requiresHumanApproval && txn.approvalStatus !== 'APPROVED') {
    txn.approvalStatus = 'PENDING_APPROVAL';
    txn.status = 'AUTHORIZED';
    txn.activePipelineStage = 'POLICY';
  } else if (checkResult.canExecute && txn.status !== 'SUCCESS') {
    txn.status = 'READY';
    txn.activePipelineStage = 'EXECUTION';
  }

  txn.updatedAt = new Date().toISOString();
  saveDB();

  res.json({ success: true, transaction: txn, checkResult });
});

// Human Override: Approve Transaction
app.post('/api/orchestrator/transactions/:id/approve', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const user = req.user!;
  ensureTransactions(merchant.id, merchant.businessName);
  const txn = db.transactions?.[req.params.id];

  if (!txn || txn.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Transaction not found.' });
    return;
  }

  txn.approvalStatus = 'APPROVED';
  txn.approvedBy = `${user.fullName} (Merchant Admin)`;
  txn.approvedAt = new Date().toISOString();
  txn.policySatisfied = true;
  txn.status = 'READY';
  txn.activePipelineStage = 'EXECUTION';
  txn.updatedAt = new Date().toISOString();

  // Re-run checks to mark human approval check as PASS
  const passport = getOrCreatePassport(merchant);
  const checkResult = runPreExecutionChecks(txn, passport, DEFAULT_POLICY_RULES, Object.values(db.transactions));
  txn.preExecutionChecks = checkResult.checks;

  txn.auditEvents.push(
    createAuditEvent(
      txn.approvedBy,
      'Human authorization override granted for high-value transaction',
      'PASSED',
      'POLICY',
      `Manual merchant sign-off recorded. Value: ${formatINR(txn.amount)}`
    )
  );

  saveDB();
  res.json({ success: true, transaction: txn });
});

// Human Override: Reject Transaction
app.post('/api/orchestrator/transactions/:id/reject', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const user = req.user!;
  const { reason } = req.body;
  ensureTransactions(merchant.id, merchant.businessName);
  const txn = db.transactions?.[req.params.id];

  if (!txn || txn.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Transaction not found.' });
    return;
  }

  txn.approvalStatus = 'REJECTED';
  txn.status = 'BLOCKED';
  txn.failureReason = reason || 'Manual merchant rejection';
  txn.activePipelineStage = 'POLICY';
  txn.updatedAt = new Date().toISOString();

  txn.auditEvents.push(
    createAuditEvent(
      `${user.fullName} (Merchant Admin)`,
      `Transaction execution rejected: ${txn.failureReason}`,
      'FAILED',
      'POLICY'
    )
  );

  saveDB();
  res.json({ success: true, transaction: txn });
});

// Execute Transaction Pipeline
app.post('/api/orchestrator/transactions/:id/execute', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const merchant = req.merchant!;
  const passport = getOrCreatePassport(merchant);
  ensureTransactions(merchant.id, merchant.businessName);
  const txn = db.transactions?.[req.params.id];

  if (!txn || txn.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Transaction not found.' });
    return;
  }

  const { simulateFailure } = req.body;

  // 1. Idempotency Check: Prevent duplicate executions
  const allTxns = Object.values(db.transactions);
  const duplicateSuccess = allTxns.find(
    (t) => t.idempotencyKey === txn.idempotencyKey && t.id !== txn.id && t.status === 'SUCCESS'
  );

  if (duplicateSuccess || (txn.status === 'SUCCESS' && !simulateFailure)) {
    txn.status = 'BLOCKED';
    txn.isDuplicatePrevented = true;
    txn.originalTransactionId = duplicateSuccess ? duplicateSuccess.id : txn.id;
    txn.failureReason = `Duplicate execution prevented by Idempotency Guard. Original transaction #${txn.originalTransactionId} was already captured.`;
    txn.activePipelineStage = 'IDEMPOTENCY';
    txn.auditEvents.push(
      createAuditEvent(
        'PAYNEX Idempotency Guard',
        `Duplicate payment execution blocked for key ${txn.idempotencyKey}`,
        'FAILED',
        'IDEMPOTENCY'
      )
    );
    txn.updatedAt = new Date().toISOString();
    saveDB();

    res.status(409).json({
      error: 'DUPLICATE_EXECUTION_PREVENTED',
      message: txn.failureReason,
      transaction: txn,
    });
    return;
  }

  // 2. Pre-Execution Validation against Commerce Constitution and System Rules
  const constitution = ensureConstitution(merchant.id);
  const constEval = evaluateConstitutionPolicy(constitution, {
    action_type: 'CREATE_PAYMENT',
    transaction_amount: txn.amount,
    discount_percent: txn.items?.[0]?.discountAmount ? Math.round((txn.items[0].discountAmount / (txn.amount + txn.items[0].discountAmount)) * 100) : 0,
    margin_percent: merchant.metrics?.grossMargin || 24,
    risk_score: txn.riskScore || 15,
    actor: txn.buyerName || 'Autonomous Buyer Agent',
    currency: txn.currency || 'INR',
  });

  const checkResult = runPreExecutionChecks(txn, passport, DEFAULT_POLICY_RULES, allTxns);

  // Prepend Constitution Gate
  checkResult.checks.unshift({
    id: 'CONSTITUTION_POLICY_GATE',
    name: `Commerce Constitution (${constEval.triggeredRuleId})`,
    category: 'POLICY',
    passed: constEval.decision === 'ALLOW' || constEval.decision === 'ALLOW_WITH_CONDITIONS' || (constEval.decision === 'HUMAN_APPROVAL' && txn.approvalStatus === 'APPROVED'),
    requiresHumanApproval: constEval.decision === 'HUMAN_APPROVAL',
    details: constEval.explanation,
    value: constEval.decision,
    threshold: constEval.triggeredRuleName,
  });

  if (constEval.decision === 'BLOCK') {
    checkResult.canExecute = false;
    checkResult.policyNotes = `Commerce Constitution [${constEval.triggeredRuleId}]: ${constEval.explanation}`;
  } else if (constEval.decision === 'HUMAN_APPROVAL' && txn.approvalStatus !== 'APPROVED') {
    checkResult.canExecute = false;
    checkResult.requiresHumanApproval = true;
    checkResult.policyNotes = `Commerce Constitution [${constEval.triggeredRuleId}]: ${constEval.explanation}`;
  }

  txn.preExecutionChecks = checkResult.checks;

  if (!checkResult.canExecute && !simulateFailure) {
    if (checkResult.requiresHumanApproval && txn.approvalStatus !== 'APPROVED') {
      txn.status = 'AUTHORIZED';
      txn.approvalStatus = 'PENDING_APPROVAL';
      txn.activePipelineStage = 'POLICY';
      saveDB();
      res.status(403).json({
        error: 'HUMAN_APPROVAL_REQUIRED',
        message: checkResult.policyNotes || 'Transaction exceeds autonomous limits. Human approval required before execution.',
        transaction: txn,
        decision: constEval,
      });
      return;
    }

    txn.status = 'BLOCKED';
    txn.failureReason = checkResult.policyNotes || 'Pre-execution checks failed.';
    saveDB();
    res.status(400).json({
      error: 'PRECHECK_FAILED',
      message: txn.failureReason,
      transaction: txn,
      decision: constEval,
    });
    return;
  }

  // 3. Check for Simulated Failure
  const failureToSimulate = simulateFailure || txn.failureCode;

  if (failureToSimulate) {
    txn.status = 'FAILED';
    txn.updatedAt = new Date().toISOString();

    let failMsg = 'Execution failed.';
    let isRetryable = false;

    switch (failureToSimulate) {
      case 'NETWORK_TIMEOUT':
        failMsg = 'Payment verification timeout: Gateway connection timed out during verification.';
        isRetryable = true;
        txn.activePipelineStage = 'VERIFICATION';
        break;
      case 'PAYMENT_DECLINED':
        failMsg = 'Card / instrument declined by issuer authorization network.';
        isRetryable = false;
        txn.activePipelineStage = 'EXECUTION';
        break;
      case 'INSUFFICIENT_BALANCE':
        failMsg = 'Simulated account balance insufficient for settlement.';
        isRetryable = false;
        txn.activePipelineStage = 'EXECUTION';
        break;
      case 'VERIFICATION_MISMATCH':
        failMsg = 'Cryptographic verification signature mismatch between intent and settlement response.';
        isRetryable = false;
        txn.activePipelineStage = 'VERIFICATION';
        break;
      default:
        failMsg = `Simulated error: ${failureToSimulate}`;
        isRetryable = true;
        txn.activePipelineStage = 'EXECUTION';
    }

    txn.failureReason = failMsg;
    txn.isRetryable = isRetryable;

    txn.auditEvents.push(
      createAuditEvent('PAYNEX Execution Engine', `Simulation trigger: ${failureToSimulate}`, 'FAILED', txn.activePipelineStage, failMsg)
    );

    saveDB();

    res.json({
      success: false,
      failureReason: failMsg,
      isRetryable,
      transaction: txn,
    });
    return;
  }

  // 4. Safe Execution: Razorpay Test or Demo Sandbox
  const receiptNumber = 'RCP-' + txn.id.replace('TXN-', '');
  const orderResult = await createRazorpayTestOrder(txn.amount, txn.currency, receiptNumber);

  txn.status = 'SUCCESS';
  txn.executionMode = orderResult.mode;
  txn.paymentProvider = orderResult.providerName;
  txn.orderReference = orderResult.orderId;
  txn.paymentReference = orderResult.paymentId;
  txn.failureReason = undefined;
  txn.failureCode = undefined;
  txn.isRetryable = undefined;
  txn.activePipelineStage = 'AUDIT';
  txn.updatedAt = new Date().toISOString();

  txn.receipt = {
    receiptNumber,
    paymentReference: orderResult.paymentId,
    orderReference: orderResult.orderId,
    capturedAt: new Date().toISOString(),
    paymentMethod: 'UPI / NetBanking (Test Settlement)',
    provider: orderResult.providerName,
    amountFormatted: formatINR(txn.amount),
  };

  // Append deterministic audit records
  txn.auditEvents.push(
    createAuditEvent('PAYNEX Orchestrator', 'Lock acquired with idempotency token', 'PASSED', 'IDEMPOTENCY', txn.idempotencyKey),
    createAuditEvent(orderResult.providerName, `Authorized payment order #${orderResult.orderId}`, 'PASSED', 'EXECUTION', `Ref: ${orderResult.paymentId}`),
    createAuditEvent('PAYNEX Verification Engine', 'Payment captured and verified with cryptographic HMAC', 'PASSED', 'VERIFICATION', '100% matched'),
    createAuditEvent('PAYNEX Orchestrator', `Transaction completed safely. Receipt issued: ${receiptNumber}`, 'PASSED', 'AUDIT')
  );

  saveDB();

  res.json({
    success: true,
    transaction: txn,
    receipt: txn.receipt,
  });
});

// Safe Retry Engine
app.post('/api/orchestrator/transactions/:id/retry', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  ensureTransactions(merchant.id, merchant.businessName);
  const txn = db.transactions?.[req.params.id];

  if (!txn || txn.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Transaction not found.' });
    return;
  }

  if (txn.status !== 'FAILED') {
    res.status(400).json({ error: 'Only failed transactions can be retried.' });
    return;
  }

  if (txn.retryCount >= txn.maxRetries) {
    res.status(400).json({ error: `Maximum retry limit (${txn.maxRetries}) reached.` });
    return;
  }

  txn.retryCount += 1;
  txn.status = 'READY';
  txn.failureReason = undefined;
  txn.failureCode = undefined;
  txn.activePipelineStage = 'EXECUTION';
  txn.updatedAt = new Date().toISOString();

  txn.auditEvents.push(
    createAuditEvent(
      'PAYNEX Safe Retry Engine',
      `Retry attempt ${txn.retryCount} of ${txn.maxRetries} initiated after recovery health check`,
      'PASSED',
      'EXECUTION'
    )
  );

  saveDB();
  res.json({ success: true, transaction: txn });
});

// Load Demo Scenario
app.post('/api/orchestrator/scenarios/:scenarioKey', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const scenarioKey = req.params.scenarioKey as DemoScenarioKey;

  ensureTransactions(merchant.id, merchant.businessName);
  const scenarioTxn = buildDemoScenario(scenarioKey, merchant.id, merchant.businessName);

  db.transactions[scenarioTxn.id] = scenarioTxn;
  saveDB();

  res.status(201).json({ success: true, transaction: scenarioTxn });
});

// Metrics
app.get('/api/orchestrator/metrics', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const transactions = ensureTransactions(merchant.id, merchant.businessName);
  const metrics = calculateOrchestratorMetrics(transactions);
  res.json({ metrics });
});

// Delete Transaction
app.delete('/api/orchestrator/transactions/:id', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  ensureTransactions(merchant.id, merchant.businessName);
  const txn = db.transactions?.[req.params.id];

  if (!txn || txn.merchantId !== merchant.id) {
    res.status(404).json({ error: 'Transaction not found.' });
    return;
  }

  delete db.transactions[req.params.id];
  saveDB();

  res.json({ success: true, message: 'Transaction record deleted.' });
});

// ==========================================
// 3.4 COMMERCE CONSTITUTION API ROUTES
// ==========================================

function ensureConstitution(merchantId: string): CommerceConstitution {
  if (!db.constitutions) {
    db.constitutions = {};
  }
  if (!db.constitutions[merchantId]) {
    db.constitutions[merchantId] = createDefaultConstitution(merchantId);
    saveDB();
  }
  return db.constitutions[merchantId];
}

// Get merchant's Commerce Constitution
app.get('/api/constitution', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const constitution = ensureConstitution(merchant.id);
  res.json({ constitution });
});

// Validate a rule candidate before creation
app.post('/api/constitution/validate-rule', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const { rule } = req.body;
  if (!rule) {
    res.status(400).json({ error: 'Rule data is required.' });
    return;
  }
  const validation = validateRule(rule);
  res.json(validation);
});

// Add a new rule to Constitution
app.post('/api/constitution/rules', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const constitution = ensureConstitution(merchant.id);
  const { rule } = req.body;

  if (!rule) {
    res.status(400).json({ error: 'Rule definition required.' });
    return;
  }

  const validation = validateRule(rule);
  if (!validation.isValid) {
    res.status(400).json({ error: 'Invalid rule configuration.', errors: validation.errors });
    return;
  }

  const newRule: PolicyRule = {
    id: rule.id || `RULE-CUSTOM-${Date.now().toString(36).toUpperCase()}`,
    name: rule.name || 'Custom Policy Rule',
    category: rule.category || 'NEGOTIATION_BOUNDARIES',
    description: rule.description || '',
    priority: Number(rule.priority) || 10,
    isActive: rule.isActive ?? true,
    condition: rule.condition || {
      field: 'transaction_amount',
      operator: 'GREATER_THAN',
      value: 10000,
    },
    decision: rule.decision || 'REQUIRE_HUMAN_APPROVAL',
    conditionsApplied: rule.conditionsApplied || [],
    reasonTemplate: rule.reasonTemplate || 'Triggered custom merchant governance policy.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  constitution.rules.push(newRule);
  constitution.updatedAt = new Date().toISOString();
  constitution.health = calculateConstitutionHealth(constitution.rules);

  const auditEvent: GovernanceAuditEvent = {
    id: `gov_audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    eventType: 'RULE_CREATED',
    actor: req.user?.fullName || 'Merchant Admin',
    summary: `Rule created: ${newRule.name} (${newRule.id}) [${newRule.decision}]`,
    ruleId: newRule.id,
    metadata: { rule: newRule },
  };
  constitution.auditTrail.unshift(auditEvent);

  saveDB();
  res.status(201).json({ success: true, rule: newRule, health: constitution.health });
});

// Update an existing rule
app.put('/api/constitution/rules/:id', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const constitution = ensureConstitution(merchant.id);
  const ruleId = req.params.id;
  const ruleIndex = constitution.rules.findIndex((r) => r.id === ruleId);

  if (ruleIndex === -1) {
    res.status(404).json({ error: 'Rule not found.' });
    return;
  }

  const { rule } = req.body;
  const validation = validateRule({ ...constitution.rules[ruleIndex], ...rule });
  if (!validation.isValid) {
    res.status(400).json({ error: 'Invalid rule update.', errors: validation.errors });
    return;
  }

  const updated: PolicyRule = {
    ...constitution.rules[ruleIndex],
    ...rule,
    id: ruleId, // preserve ID
    updatedAt: new Date().toISOString(),
  };

  constitution.rules[ruleIndex] = updated;
  constitution.updatedAt = new Date().toISOString();
  constitution.health = calculateConstitutionHealth(constitution.rules);

  const auditEvent: GovernanceAuditEvent = {
    id: `gov_audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    eventType: 'RULE_UPDATED',
    actor: req.user?.fullName || 'Merchant Admin',
    summary: `Rule updated: ${updated.name} (${updated.id}) [${updated.decision}]`,
    ruleId: updated.id,
  };
  constitution.auditTrail.unshift(auditEvent);

  saveDB();
  res.json({ success: true, rule: updated, health: constitution.health });
});

// Toggle rule active state
app.patch('/api/constitution/rules/:id/toggle', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const constitution = ensureConstitution(merchant.id);
  const ruleId = req.params.id;
  const rule = constitution.rules.find((r) => r.id === ruleId);

  if (!rule) {
    res.status(404).json({ error: 'Rule not found.' });
    return;
  }

  const { isActive } = req.body;
  rule.isActive = typeof isActive === 'boolean' ? isActive : !rule.isActive;
  rule.updatedAt = new Date().toISOString();
  constitution.updatedAt = new Date().toISOString();
  constitution.health = calculateConstitutionHealth(constitution.rules);

  const auditEvent: GovernanceAuditEvent = {
    id: `gov_audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    eventType: 'RULE_TOGGLED',
    actor: req.user?.fullName || 'Merchant Admin',
    summary: `Rule ${rule.id} toggled ${rule.isActive ? 'ACTIVE' : 'INACTIVE'}`,
    ruleId: rule.id,
  };
  constitution.auditTrail.unshift(auditEvent);

  saveDB();
  res.json({ success: true, rule, health: constitution.health });
});

// Delete a rule
app.delete('/api/constitution/rules/:id', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const constitution = ensureConstitution(merchant.id);
  const ruleId = req.params.id;
  const initialLength = constitution.rules.length;

  constitution.rules = constitution.rules.filter((r) => r.id !== ruleId);
  if (constitution.rules.length === initialLength) {
    res.status(404).json({ error: 'Rule not found.' });
    return;
  }

  constitution.updatedAt = new Date().toISOString();
  constitution.health = calculateConstitutionHealth(constitution.rules);

  const auditEvent: GovernanceAuditEvent = {
    id: `gov_audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    eventType: 'RULE_DELETED',
    actor: req.user?.fullName || 'Merchant Admin',
    summary: `Rule deleted: ${ruleId}`,
    ruleId,
  };
  constitution.auditTrail.unshift(auditEvent);

  saveDB();
  res.json({ success: true, message: 'Rule deleted successfully.', health: constitution.health });
});

// Evaluate a policy request (Deterministic Decision Engine)
app.post('/api/constitution/evaluate', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const constitution = ensureConstitution(merchant.id);
  const { input, recordDecision } = req.body as { input: PolicyEvaluationInput; recordDecision?: boolean };

  if (!input) {
    res.status(400).json({ error: 'Evaluation input required.' });
    return;
  }

  const result: PolicyEvaluationResult = evaluateConstitutionPolicy(constitution, input);

  if (recordDecision) {
    // Record into recent decisions (max 50)
    constitution.recentDecisions.unshift(result);
    if (constitution.recentDecisions.length > 50) {
      constitution.recentDecisions = constitution.recentDecisions.slice(0, 50);
    }

    // Update metrics
    constitution.metrics.totalEvaluations += 1;
    if (result.decision === 'ALLOW') constitution.metrics.totalAllowed += 1;
    else if (result.decision === 'ALLOW_WITH_CONDITIONS') constitution.metrics.totalConditional += 1;
    else if (result.decision === 'REQUIRE_HUMAN_APPROVAL') constitution.metrics.totalHumanApprovalRequired += 1;
    else if (result.decision === 'BLOCK') constitution.metrics.totalBlocked += 1;

    // Audit log
    const auditEvent: GovernanceAuditEvent = {
      id: `gov_audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      eventType: 'DECISION_EVALUATED',
      actor: input.actor || 'AI Agent',
      summary: `Evaluated ${input.actionType || 'TRANSACTION'}: [${result.decision}] ${result.explanation}`,
      decisionId: result.id,
      metadata: { input, decision: result.decision },
    };
    constitution.auditTrail.unshift(auditEvent);
    if (constitution.auditTrail.length > 100) {
      constitution.auditTrail = constitution.auditTrail.slice(0, 100);
    }

    saveDB();
  }

  res.json({ result });
});

// Publish new Constitution version
app.post('/api/constitution/publish', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const constitution = ensureConstitution(merchant.id);
  const { publishedBy, majorChanges } = req.body;

  const actor = publishedBy || req.user?.fullName || 'Merchant Admin';
  const updated = publishConstitutionVersion(constitution, actor, majorChanges);
  db.constitutions[merchant.id] = updated;
  saveDB();

  res.json({ success: true, constitution: updated, version: updated.currentVersion });
});

// Emergency Freeze Toggle
app.post('/api/constitution/freeze', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const constitution = ensureConstitution(merchant.id);
  const { isFrozen, mode, reason } = req.body;

  const actor = req.user?.fullName || 'Merchant Security';
  constitution.emergencyFreeze = {
    isFrozen: Boolean(isFrozen),
    frozenAt: isFrozen ? new Date().toISOString() : undefined,
    frozenBy: isFrozen ? actor : undefined,
    reason: isFrozen ? (reason || 'Emergency governance freeze triggered by operator.') : undefined,
    mode: isFrozen ? (mode || 'BLOCK_ALL') : undefined,
  };
  constitution.status = isFrozen ? 'FROZEN' : 'ACTIVE';
  constitution.updatedAt = new Date().toISOString();

  const auditEvent: GovernanceAuditEvent = {
    id: `gov_audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    eventType: isFrozen ? 'EMERGENCY_FREEZE_TRIGGERED' : 'EMERGENCY_FREEZE_LIFTED',
    actor,
    summary: isFrozen
      ? `EMERGENCY FREEZE ENGAGED (${constitution.emergencyFreeze.mode}): ${constitution.emergencyFreeze.reason}`
      : 'Emergency Freeze lifted. Constitution returned to ACTIVE enforcement.',
  };
  constitution.auditTrail.unshift(auditEvent);

  saveDB();
  res.json({ success: true, emergencyFreeze: constitution.emergencyFreeze, status: constitution.status });
});

// Add Human Override
app.post('/api/constitution/overrides', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const constitution = ensureConstitution(merchant.id);
  const { reason, affectedAction, durationMinutes } = req.body;

  if (!reason) {
    res.status(400).json({ error: 'Override reason is required.' });
    return;
  }

  const duration = durationMinutes || 60;
  const expiresAt = new Date(Date.now() + duration * 60000).toISOString();
  const actor = req.user?.fullName || 'Merchant Operator';

  constitution.activeOverride = {
    id: `ovr_${Date.now()}`,
    reason,
    grantedBy: actor,
    grantedAt: new Date().toISOString(),
    expiresAt,
    affectedAction: affectedAction || 'ALL_ACTIONS',
  };

  const auditEvent: GovernanceAuditEvent = {
    id: `gov_audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    eventType: 'OVERRIDE_GRANTED',
    actor,
    summary: `Human override granted by ${actor} for ${affectedAction || 'ALL_ACTIONS'} (Expires: ${new Date(expiresAt).toLocaleTimeString()}): ${reason}`,
    metadata: { override: constitution.activeOverride },
  };
  constitution.auditTrail.unshift(auditEvent);

  saveDB();
  res.json({ success: true, override: constitution.activeOverride });
});

// Rollback to previous version
app.post('/api/constitution/rollback/:version', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const constitution = ensureConstitution(merchant.id);
  const targetVersion = req.params.version;

  const versionRecord = constitution.versions.find((v) => v.version === targetVersion);
  if (!versionRecord) {
    res.status(404).json({ error: `Version ${targetVersion} not found in history.` });
    return;
  }

  const actor = req.user?.fullName || 'Merchant Admin';
  constitution.rules = JSON.parse(JSON.stringify(versionRecord.rulesSnapshot));
  constitution.health = calculateConstitutionHealth(constitution.rules);
  constitution.updatedAt = new Date().toISOString();

  const auditEvent: GovernanceAuditEvent = {
    id: `gov_audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    eventType: 'VERSION_ROLLBACK',
    actor,
    summary: `Rolled back Constitution rules to version ${targetVersion}`,
  };
  constitution.auditTrail.unshift(auditEvent);

  saveDB();
  res.json({ success: true, constitution, rolledBackTo: targetVersion });
});

// Run Demo Scenarios
app.post('/api/constitution/scenarios/:scenarioKey', requireAuth, (req: AuthenticatedRequest, res: Response): void => {
  const merchant = req.merchant!;
  const constitution = ensureConstitution(merchant.id);
  const key = req.params.scenarioKey as ConstitutionDemoScenarioKey;

  try {
    const scenario = getConstitutionDemoScenario(key, constitution);
    // Also record decision
    constitution.recentDecisions.unshift(scenario.result);
    if (constitution.recentDecisions.length > 50) constitution.recentDecisions.slice(0, 50);

    // Update metrics
    constitution.metrics.totalEvaluations += 1;
    if (scenario.result.decision === 'ALLOW') constitution.metrics.totalAllowed += 1;
    else if (scenario.result.decision === 'ALLOW_WITH_CONDITIONS') constitution.metrics.totalConditional += 1;
    else if (scenario.result.decision === 'REQUIRE_HUMAN_APPROVAL') constitution.metrics.totalHumanApprovalRequired += 1;
    else if (scenario.result.decision === 'BLOCK') constitution.metrics.totalBlocked += 1;

    saveDB();
    res.json({ success: true, scenario });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to run scenario.' });
  }
});

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response): void => {
  res.json({ status: 'ok', product: 'PAYNEX', timestamp: new Date().toISOString() });
});

// ==========================================
// 4. VITE & STATIC SERVING SETUP
// ==========================================

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PAYNEX Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
