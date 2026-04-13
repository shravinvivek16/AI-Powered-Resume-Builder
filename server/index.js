import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
const port = process.env.PORT || 8787;
const serverVersion = 'resume-ai-server-2026-04-13-v2';
const configuredModel = process.env.GEMINI_MODEL || '';
const fallbackModels = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash-latest'];
const maxModelAttempts = 3;

const stripModelPrefix = (name = '') => name.replace(/^models\//, '');

const getAvailableGenerateModels = async (apiKey) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const response = await fetch(url, { signal: controller.signal });
  clearTimeout(timeout);
  if (!response.ok) {
    throw new Error(`ListModels failed with status ${response.status}`);
  }

  const payload = await response.json();
  const models = Array.isArray(payload.models) ? payload.models : [];
  return models
    .filter((model) => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
    .map((model) => stripModelPrefix(model.name))
    .filter(Boolean);
};

const withTimeout = async (promise, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const rankModel = (modelName) => {
  if (modelName.includes('2.5') && modelName.includes('flash')) return 0;
  if (modelName.includes('2.0') && modelName.includes('flash')) return 1;
  if (modelName.includes('1.5') && modelName.includes('flash')) return 2;
  if (modelName.includes('pro')) return 3;
  return 4;
};

const normalizeResumeShape = (payload) => ({
  headline: typeof payload?.headline === 'string' ? payload.headline.trim() : '',
  executiveSummary: typeof payload?.executiveSummary === 'string' ? payload.executiveSummary.trim() : '',
  profileBullets: Array.isArray(payload?.profileBullets) ? payload.profileBullets.filter(Boolean).map(String) : [],
  keyStrengths: Array.isArray(payload?.keyStrengths) ? payload.keyStrengths.filter(Boolean).map(String) : [],
  growthNarrative: typeof payload?.growthNarrative === 'string' ? payload.growthNarrative.trim() : '',
  growthBullets: Array.isArray(payload?.growthBullets) ? payload.growthBullets.filter(Boolean).map(String) : [],
  experienceBullets: Array.isArray(payload?.experienceBullets)
    ? payload.experienceBullets.filter(Boolean).map(String)
    : [],
});

const isCompleteResume = (resume) =>
  resume.headline &&
  resume.executiveSummary &&
  resume.growthNarrative &&
  resume.profileBullets.length >= 2 &&
  resume.keyStrengths.length >= 3 &&
  resume.growthBullets.length >= 1 &&
  resume.experienceBullets.length >= 4;

const sentenceFrom = (text, fallback) => {
  const value = typeof text === 'string' ? text.trim() : '';
  return value || fallback;
};

const ensureMinItems = (items, min, fillers) => {
  const output = Array.isArray(items) ? [...items] : [];
  for (const filler of fillers) {
    if (output.length >= min) break;
    output.push(filler);
  }
  return output.slice(0, Math.max(min, output.length));
};

const extractNumericTokens = (value) => {
  const matches = String(value || '').match(/\b\d+(?:\.\d+)?%?\b/g);
  return matches ? matches.map((token) => token.trim()) : [];
};

const collectAllowedNumericTokens = ({
  yearsExperience,
  careerStart,
  strengthLine,
  weaknessLine,
  validCompanies,
}) => {
  const tokens = new Set();
  [yearsExperience, careerStart, strengthLine, weaknessLine].forEach((entry) => {
    extractNumericTokens(entry).forEach((token) => tokens.add(token));
  });
  validCompanies.forEach((company) => {
    [company.name, company.role, company.duration].forEach((entry) => {
      extractNumericTokens(entry).forEach((token) => tokens.add(token));
    });
  });
  return tokens;
};

const scrubUnverifiedClaims = (text, allowedNumericTokens) => {
  const source = String(text || '').trim();
  if (!source) return '';

  let cleaned = source
    .replace(/\b\d+%(\s+[a-z]+){0,8}/gi, 'notable improvements')
    .replace(/\b\d+\+?\s+(professionals|people|employees|team members)\b/gi, 'cross-functional teams')
    .replace(/\b(first year|quarter-over-quarter|year-over-year)\b/gi, 'over the engagement period')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();

  cleaned = cleaned
    .replace(/\b\d+(?:\.\d+)?%?\b/g, (token) =>
      allowedNumericTokens.has(token.trim()) ? token : '',
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();

  return cleaned;
};

const hasTemplatePlaceholder = (text) => /\[[^[\]]+\]/.test(String(text || ''));

const isVagueTemplateLine = (text) => {
  const line = String(text || '').toLowerCase();
  const vaguePatterns = [
    'specific project outcome',
    'process name',
    'positive outcome',
    'specific metric',
    'area of achievement',
    'projected to increase',
    'resulting in a',
    'exceeding initial expectations',
    'spearheaded initiative',
    'recognized for outstanding performance',
  ];
  return vaguePatterns.some((pattern) => line.includes(pattern));
};

const cleanLines = (lines, allowedNumericTokens) =>
  lines
    .map((line) => scrubUnverifiedClaims(line, allowedNumericTokens))
    .filter((line) => line && !hasTemplatePlaceholder(line) && !isVagueTemplateLine(line));

const sanitizeResumeClaims = (resume, allowedNumericTokens) => ({
  ...resume,
  executiveSummary:
    hasTemplatePlaceholder(resume.executiveSummary) || isVagueTemplateLine(resume.executiveSummary)
      ? ''
      : scrubUnverifiedClaims(resume.executiveSummary, allowedNumericTokens),
  growthNarrative:
    hasTemplatePlaceholder(resume.growthNarrative) || isVagueTemplateLine(resume.growthNarrative)
      ? ''
      : scrubUnverifiedClaims(resume.growthNarrative, allowedNumericTokens),
  profileBullets: cleanLines(resume.profileBullets, allowedNumericTokens),
  keyStrengths: cleanLines(resume.keyStrengths, allowedNumericTokens),
  growthBullets: cleanLines(resume.growthBullets, allowedNumericTokens),
  experienceBullets: cleanLines(resume.experienceBullets, allowedNumericTokens),
});

const buildFactGroundedFallback = ({
  fullName,
  currentRole,
  yearsExperience,
  careerStart,
  strengthLine,
  weaknessLine,
  validCompanies,
}) => {
  const roleLabel = currentRole || 'Professional Candidate';
  const leadCompany = validCompanies[0];
  const latestCompany = validCompanies[validCompanies.length - 1];
  const profileBullets = [
    `${yearsExperience} years of progression since ${careerStart} across practical business contexts.`,
    `Primary strengths include ${strengthLine}, applied consistently in role execution.`,
    `Experience spans ${validCompanies.length} company environment(s) with role-based accountability.`,
  ];
  const keyStrengths = [
    ...strengthLine
      .split(/[;,]/)
      .map((part) => part.trim())
      .filter(Boolean),
    'Structured execution',
    'Cross-functional collaboration',
    'Clear communication',
    'Ownership mindset',
  ].slice(0, 5);
  const growthSource = weaknessLine?.trim()
    ? `Actively improving in ${weaknessLine.trim()} through deliberate execution habits.`
    : 'Continuously improving through feedback loops and focused capability development.';
  const growthBullets = weaknessLine?.trim()
    ? [
        `Turns ${weaknessLine.trim()} into a measurable development focus.`,
        'Builds stronger consistency through reflection, iteration, and accountable follow-through.',
      ]
    : [
        'Applies feedback cycles to improve decision quality and delivery consistency.',
        'Expands capability depth through structured learning and practical execution.',
      ];
  const experienceBullets = validCompanies.map(
    (company) => `Delivered in the role of ${company.role} at ${company.name} over ${company.duration}.`,
  );
  while (experienceBullets.length < 6) {
    experienceBullets.push(
      `Contributed to role-critical outcomes within ${latestCompany?.name || 'assigned business environments'}.`,
    );
  }

  return {
    headline: `${roleLabel}`,
    executiveSummary: `${fullName || 'This candidate'} brings ${yearsExperience} years of experience starting from ${careerStart}. Has operated in roles such as ${leadCompany?.role || 'professional contributor'} across ${validCompanies.length} organization(s), combining execution discipline with practical business judgment.`,
    profileBullets,
    keyStrengths,
    growthNarrative: growthSource,
    growthBullets,
    experienceBullets: experienceBullets.slice(0, 6),
  };
};

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: serverVersion });
});

app.post('/api/generate-resume', async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Missing GEMINI_API_KEY in environment variables.' });
    }

    const { fullName, currentRole, yearsExperience, careerStart, strengthLine, weaknessLine, companies } = req.body ?? {};

    if (!yearsExperience || !careerStart || !strengthLine || !Array.isArray(companies) || companies.length === 0) {
      return res.status(400).json({
        error: 'Please provide yearsExperience, careerStart, strengthLine, and at least one company.',
      });
    }
    const validCompanies = companies.filter((company) => company?.name && company?.role && company?.duration);
    if (validCompanies.length === 0) {
      return res.status(400).json({
        error: 'Each company entry needs company name, role, and duration.',
      });
    }

    const companyLines = validCompanies
      .map((company, index) => `${index + 1}. ${company.role} at ${company.name} - ${company.duration}`)
      .join('\n');

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const listedModels = await getAvailableGenerateModels(process.env.GEMINI_API_KEY);

    const preferredCandidates = [configuredModel, ...fallbackModels].filter(Boolean);
    const orderedCandidates = [
      ...preferredCandidates.filter((modelName) => listedModels.includes(modelName)),
      ...listedModels.filter((modelName) => !preferredCandidates.includes(modelName)),
    ].sort((a, b) => rankModel(a) - rankModel(b));
    const modelCandidates = orderedCandidates.slice(0, maxModelAttempts);

    const prompt = `
You are an elite executive resume writer.

Candidate details:
- Full name: ${fullName || 'Not provided'}
- Current target role: ${currentRole || 'Not provided'}
- Years of experience: ${yearsExperience}
- Career started: ${careerStart}
- Strength one-liner: ${strengthLine}
- Growth-area one-liner: ${weaknessLine || 'Not provided'}
- Companies and duration:
${companyLines}

Create a highly professional one-page resume narrative.
Return only minified JSON with this exact schema:
{
  "headline": "short professional title",
  "executiveSummary": "2-3 sentence concise paragraph",
  "profileBullets": ["exactly 3 concise bullets"],
  "keyStrengths": ["5 concise strengths"],
  "growthNarrative": "1-2 sentence constructive paragraph",
  "growthBullets": ["2 constructive growth bullets based on weakness input"],
  "experienceBullets": ["exactly 6 impact-oriented bullets with measurable style wording"]
}

Rules:
- No markdown.
- No extra keys.
- No preamble, no code fences.
- Keep language credible and ATS-friendly.
- Keep each bullet to 9-16 words.
- Keep paragraphs brief and impactful, not verbose.
- Use a balanced mix of concise paragraphs and bullet points.
- Ground every line in provided facts only (role, companies, durations, strengths, growth area).
- Do not invent metrics, percentages, awards, promotions, or company names not in input.
- Avoid generic filler phrases that could fit any candidate.
- Do not output percentage improvements or quantified business impact unless user explicitly provided those metrics.
- Ensure wording is specific to this candidate's provided roles and companies; avoid repeated canned bullet templates.
- Never introduce numeric claims that are not explicitly present in candidate input.
`;

    if (modelCandidates.length === 0) {
      throw new Error(`No supported Gemini model available. Listed models: ${listedModels.join(', ') || 'none'}`);
    }

    const attempts = modelCandidates.map((modelName) => {
      const model = genAI.getGenerativeModel({ model: modelName });
      return withTimeout(
        model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
          },
        }),
        15000,
        `Gemini request via model ${modelName}`,
      );
    });

    let result;
    try {
      result = await Promise.any(attempts);
    } catch {
      throw new Error(`All model attempts failed. Tried: ${modelCandidates.join(', ')}`);
    }
    const rawText = result.response.text().trim();
    const jsonCandidate = rawText.match(/\{[\s\S]*\}/)?.[0];

    if (!jsonCandidate) {
      return res.status(500).json({ error: 'AI output could not be parsed as JSON.' });
    }

    let parsed = normalizeResumeShape(JSON.parse(jsonCandidate));
    if (!isCompleteResume(parsed)) {
      const repairPrompt = `
You previously returned incomplete resume JSON.
Return complete minified JSON with all required fields and meaningful values.

Candidate details:
- Full name: ${fullName || 'Not provided'}
- Current target role: ${currentRole || 'Not provided'}
- Years of experience: ${yearsExperience}
- Career started: ${careerStart}
- Strength one-liner: ${strengthLine}
- Growth-area one-liner: ${weaknessLine || 'Not provided'}
- Companies and duration:
${companyLines}

Schema:
{
  "headline": "short professional title",
  "executiveSummary": "2-3 sentence concise paragraph",
  "profileBullets": ["exactly 3 concise bullets"],
  "keyStrengths": ["5 concise strengths"],
  "growthNarrative": "1-2 sentence constructive paragraph",
  "growthBullets": ["2 constructive growth bullets based on weakness input"],
  "experienceBullets": ["exactly 6 impact-oriented bullets with measurable style wording"]
}

Rules:
- Do not invent metrics, percentages, awards, promotions, or company names not in input.
- Keep output tightly grounded in provided facts only.
- Never introduce numeric claims that are not explicitly present in candidate input.
`;

      const repairAttempts = modelCandidates.map((modelName) => {
        const model = genAI.getGenerativeModel({ model: modelName });
        return withTimeout(
          model.generateContent({
            contents: [{ role: 'user', parts: [{ text: repairPrompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
            },
          }),
          12000,
          `Gemini repair request via model ${modelName}`,
        );
      });

      const repairResult = await Promise.any(repairAttempts);
      const repairRaw = repairResult.response.text().trim();
      const repairJson = repairRaw.match(/\{[\s\S]*\}/)?.[0];
      if (repairJson) {
        parsed = normalizeResumeShape(JSON.parse(repairJson));
      }
    }

    if (!isCompleteResume(parsed)) {
      const fallback = buildFactGroundedFallback({
        fullName,
        currentRole,
        yearsExperience,
        careerStart,
        strengthLine,
        weaknessLine,
        validCompanies,
      });
      parsed = {
        headline: sentenceFrom(parsed.headline, fallback.headline),
        executiveSummary: sentenceFrom(parsed.executiveSummary, fallback.executiveSummary),
        profileBullets: ensureMinItems(parsed.profileBullets, 3, fallback.profileBullets),
        keyStrengths: ensureMinItems(parsed.keyStrengths, 5, fallback.keyStrengths),
        growthNarrative: sentenceFrom(parsed.growthNarrative, fallback.growthNarrative),
        growthBullets: ensureMinItems(parsed.growthBullets, 2, fallback.growthBullets),
        experienceBullets: ensureMinItems(parsed.experienceBullets, 6, fallback.experienceBullets),
      };
    }
    const allowedNumericTokens = collectAllowedNumericTokens({
      yearsExperience,
      careerStart,
      strengthLine,
      weaknessLine,
      validCompanies,
    });
    parsed = sanitizeResumeClaims(parsed, allowedNumericTokens);

    if (!isCompleteResume(parsed)) {
      const fallback = buildFactGroundedFallback({
        fullName,
        currentRole,
        yearsExperience,
        careerStart,
        strengthLine,
        weaknessLine,
        validCompanies,
      });
      parsed = {
        headline: sentenceFrom(parsed.headline, fallback.headline),
        executiveSummary: sentenceFrom(parsed.executiveSummary, fallback.executiveSummary),
        profileBullets: ensureMinItems(parsed.profileBullets, 3, fallback.profileBullets),
        keyStrengths: ensureMinItems(parsed.keyStrengths, 5, fallback.keyStrengths),
        growthNarrative: sentenceFrom(parsed.growthNarrative, fallback.growthNarrative),
        growthBullets: ensureMinItems(parsed.growthBullets, 2, fallback.growthBullets),
        experienceBullets: ensureMinItems(parsed.experienceBullets, 6, fallback.experienceBullets),
      };
    }

    if (!isCompleteResume(parsed)) {
      return res.status(500).json({
        error: 'Failed to generate complete resume content.',
        details: 'AI returned incomplete fields. Please regenerate.',
      });
    }

    return res.json(parsed);
  } catch (error) {
    const details = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({
      error: 'Failed to generate resume content.',
      details,
    });
  }
});

const server = app.listen(port, () => {
  console.log(`Resume AI server running on http://localhost:${port}`);
});

server.on('error', (error) => {
  console.error('Server error:', error);
});

server.on('close', () => {
  console.error('Server closed unexpectedly.');
});

// Keep process alive in environments that aggressively dispose idle handles.
setInterval(() => {}, 60_000);
