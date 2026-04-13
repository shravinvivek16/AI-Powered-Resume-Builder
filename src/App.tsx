import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { useMemo, useRef, useState } from 'react';
import './App.css';

type Theme = 'boardroom-red' | 'navy-stripe' | 'crimson-edge' | 'signature-duo';

type Company = {
  name: string;
  role: string;
  duration: string;
};

type ResumeResponse = {
  headline: string;
  executiveSummary: string;
  profileBullets: string[];
  keyStrengths: string[];
  growthNarrative: string;
  growthBullets: string[];
  experienceBullets: string[];
};

const initialCompanies: Company[] = [{ name: '', role: '', duration: '' }];
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787';

const normalizeResume = (payload: unknown): ResumeResponse => {
  const data = (payload ?? {}) as Record<string, unknown>;
  const toList = (value: unknown) =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim().length > 0) : [];

  return {
    headline: typeof data.headline === 'string' ? data.headline : '',
    executiveSummary: typeof data.executiveSummary === 'string' ? data.executiveSummary : '',
    profileBullets: toList(data.profileBullets),
    keyStrengths: toList(data.keyStrengths),
    growthNarrative: typeof data.growthNarrative === 'string' ? data.growthNarrative : '',
    growthBullets: toList(data.growthBullets),
    experienceBullets: toList(data.experienceBullets),
  };
};

const buildClientFallbackResume = (input: {
  fullName: string;
  currentRole: string;
  yearsExperience: string;
  careerStart: string;
  strengthLine: string;
  weaknessLine: string;
  companies: Company[];
}): ResumeResponse => {
  const companies = input.companies.filter((c) => c.name && c.role && c.duration);
  const roleLabel = input.currentRole || 'Professional Candidate';
  const headline = `${roleLabel}`;
  const executiveSummary = `${input.fullName || 'This candidate'} has ${input.yearsExperience} years of experience since ${input.careerStart}, with role ownership across ${companies.length || 1} organization(s).`;
  const profileBullets = [
    `Applied ${input.strengthLine || 'core professional strengths'} in practical role execution.`,
    `Built experience through ${companies.length || 1} company environment(s) and cross-team work.`,
    `Focused on reliable delivery aligned to role and business expectations.`,
  ];
  const keyStrengths = [
    ...input.strengthLine
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean),
    'Structured execution',
    'Communication',
    'Collaboration',
    'Ownership',
  ].slice(0, 5);
  const growthNarrative = input.weaknessLine
    ? `Actively improving in ${input.weaknessLine} with measurable execution habits.`
    : 'Continuously improving through feedback, iteration, and focused skill development.';
  const growthBullets = input.weaknessLine
    ? [
        `Turns ${input.weaknessLine} into a deliberate development track.`,
        'Builds consistency through reflection and prioritized follow-through.',
      ]
    : [
        'Uses feedback loops to sharpen judgment and execution quality.',
        'Strengthens capability depth through practical, role-aligned learning.',
      ];
  const experienceBullets = companies.map(
    (c) => `Delivered responsibilities as ${c.role} at ${c.name} over ${c.duration}.`,
  );
  while (experienceBullets.length < 6) {
    experienceBullets.push('Contributed to priority outcomes through role-focused execution and collaboration.');
  }

  return {
    headline,
    executiveSummary,
    profileBullets,
    keyStrengths,
    growthNarrative,
    growthBullets,
    experienceBullets: experienceBullets.slice(0, 6),
  };
};

function App() {
  const [fullName, setFullName] = useState('');
  const [currentRole, setCurrentRole] = useState('');
  const [yearsExperience, setYearsExperience] = useState('');
  const [careerStart, setCareerStart] = useState('');
  const [strengthLine, setStrengthLine] = useState('');
  const [weaknessLine, setWeaknessLine] = useState('');
  const [companies, setCompanies] = useState<Company[]>(initialCompanies);
  const [theme, setTheme] = useState<Theme>('boardroom-red');
  const [resume, setResume] = useState<ResumeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const resumeRef = useRef<HTMLDivElement>(null);
  const hasResume = Boolean(resume);

  const validCompanies = useMemo(
    () => companies.filter((company) => company.name.trim() && company.role.trim() && company.duration.trim()),
    [companies],
  );

  const updateCompany = (index: number, field: keyof Company, value: string) => {
    setCompanies((prev) =>
      prev.map((company, i) => (i === index ? { ...company, [field]: value } : company)),
    );
  };

  const addCompany = () => {
    setCompanies((prev) => [...prev, { name: '', role: '', duration: '' }]);
  };

  const removeCompany = (index: number) => {
    setCompanies((prev) => {
      if (prev.length === 1) {
        return prev;
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const generateResume = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');

    if (!yearsExperience || !careerStart || validCompanies.length === 0 || !strengthLine.trim()) {
      setError('Fill core fields, at least one company/role, and your one-line strengths.');
      return;
    }

    try {
      setLoading(true);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 35000);
      const response = await fetch(`${apiBaseUrl}/api/generate-resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          fullName,
          currentRole,
          yearsExperience,
          careerStart,
          strengthLine,
          weaknessLine,
          companies: validCompanies,
        }),
      });
      clearTimeout(timeout);

      const data = await response.json();
      if (!response.ok) {
        const detailedError = data.details ? `${data.error} (${data.details})` : data.error;
        throw new Error(detailedError || 'Unable to generate resume content.');
      }
      const normalized = normalizeResume(data);
      const fallback = buildClientFallbackResume({
        fullName,
        currentRole,
        yearsExperience,
        careerStart,
        strengthLine,
        weaknessLine,
        companies: validCompanies,
      });

      setResume({
        headline: normalized.headline || fallback.headline,
        executiveSummary: normalized.executiveSummary || fallback.executiveSummary,
        profileBullets: normalized.profileBullets.length ? normalized.profileBullets : fallback.profileBullets,
        keyStrengths: normalized.keyStrengths.length ? normalized.keyStrengths : fallback.keyStrengths,
        growthNarrative: normalized.growthNarrative || fallback.growthNarrative,
        growthBullets: normalized.growthBullets.length ? normalized.growthBullets : fallback.growthBullets,
        experienceBullets: normalized.experienceBullets.length
          ? normalized.experienceBullets
          : fallback.experienceBullets,
      });
    } catch (requestError) {
      const message =
        requestError instanceof Error && requestError.name === 'AbortError'
          ? 'Generation timed out. Please try again.'
          : requestError instanceof Error
            ? requestError.message
            : 'Something went wrong.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const downloadPdf = async () => {
    if (!resumeRef.current) return;

    const sourceNode = resumeRef.current;
    const exportNode = sourceNode.cloneNode(true) as HTMLDivElement;
    exportNode.style.width = '794px';
    exportNode.style.height = '1123px';
    exportNode.style.maxHeight = '1123px';
    exportNode.style.maxWidth = '794px';
    exportNode.style.margin = '0';
    exportNode.style.borderRadius = '0';
    exportNode.style.overflow = 'hidden';

    const wrapper = document.createElement('div');
    wrapper.style.position = 'fixed';
    wrapper.style.left = '-99999px';
    wrapper.style.top = '0';
    wrapper.style.background = '#ffffff';
    wrapper.appendChild(exportNode);
    document.body.appendChild(wrapper);

    const canvas = await html2canvas(exportNode, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
    });
    document.body.removeChild(wrapper);

    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    pdf.addImage(imgData, 'PNG', 0, 0, pageWidth, pageHeight);

    const safeName = fullName.trim().replace(/\s+/g, '-').toLowerCase() || 'resume';
    pdf.save(`${safeName}.pdf`);
  };

  return (
    <main className="app-shell">
      <section className="panel form-panel">
        <p className="eyebrow">AI Career Studio</p>
        <h1>AI Resume Builder</h1>
        <p className="subtext">Generate an executive-grade resume summary from your experience.</p>

        <form onSubmit={generateResume} className="form-grid">
          <label>
            Full Name
            <input value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </label>

          <label>
            Target Role
            <input value={currentRole} onChange={(event) => setCurrentRole(event.target.value)} />
          </label>

          <label>
            Years of Experience *
            <input
              type="number"
              min="0"
              value={yearsExperience}
              onChange={(event) => setYearsExperience(event.target.value)}
              required
            />
          </label>

          <label>
            Start of Career *
            <input
              type="month"
              value={careerStart}
              onChange={(event) => setCareerStart(event.target.value)}
              required
            />
          </label>

          <label>
            One-line strengths *
            <input
              placeholder="e.g. Strategic thinker, excellent stakeholder communicator"
              value={strengthLine}
              onChange={(event) => setStrengthLine(event.target.value)}
              required
            />
          </label>

          <label>
            One-line growth areas (optional)
            <input
              placeholder="e.g. Perfectionism; can over-index on details"
              value={weaknessLine}
              onChange={(event) => setWeaknessLine(event.target.value)}
            />
          </label>

          <label>
            Resume Theme
            <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
              <option value="boardroom-red">Boardroom Red</option>
              <option value="navy-stripe">Navy Stripe</option>
              <option value="crimson-edge">Crimson Edge</option>
              <option value="signature-duo">Signature Duo</option>
            </select>
          </label>

          <div className="companies">
            <h3>Companies Worked At *</h3>
            {companies.map((company, index) => (
              <div className="company-row" key={`company-${index}`}>
                <input
                  placeholder="Company name"
                  value={company.name}
                  onChange={(event) => updateCompany(index, 'name', event.target.value)}
                />
                <input
                  placeholder="Role title (e.g., Senior Product Manager)"
                  value={company.role}
                  onChange={(event) => updateCompany(index, 'role', event.target.value)}
                />
                <input
                  placeholder="Duration (e.g., 2 years)"
                  value={company.duration}
                  onChange={(event) => updateCompany(index, 'duration', event.target.value)}
                />
                <button type="button" onClick={() => removeCompany(index)}>
                  Remove
                </button>
              </div>
            ))}
            <button type="button" onClick={addCompany} className="ghost">
              + Add Company
            </button>
          </div>

          <button type="submit" className="primary" disabled={loading}>
            {loading ? 'Generating...' : 'Generate AI Resume'}
          </button>
        </form>

        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel preview-panel">
        <div ref={resumeRef} className={`resume-preview ${theme}`}>
          <h2>{fullName || 'Your Name'}</h2>
          <p className="headline">{resume?.headline || currentRole || ''}</p>
          <p className="meta">
            {yearsExperience || '-'} years experience | Career started {careerStart || '-'}
          </p>

          {!hasResume && <p className="brief-paragraph">Generate your AI resume to populate this template.</p>}

          {hasResume && resume && (
            <>
              <h3>Professional Profile</h3>
              <p className="brief-paragraph">{resume.executiveSummary}</p>
              <ul>
                {resume.profileBullets.map((line, index) => (
                  <li key={`profile-${index}`}>{line}</li>
                ))}
              </ul>

              <h3>Core Strengths</h3>
              <ul>
                {resume.keyStrengths.map((strength, index) => (
                  <li key={`strength-${index}`}>{strength}</li>
                ))}
              </ul>

              <h3>Growth Narrative</h3>
              <p className="brief-paragraph">{resume.growthNarrative}</p>
              <ul>
                {resume.growthBullets.map((line, index) => (
                  <li key={`growth-${index}`}>{line}</li>
                ))}
              </ul>

              <h3>Experience Highlights</h3>
              <ul>
                {resume.experienceBullets.map((bullet, index) => (
                  <li key={`bullet-${index}`}>{bullet}</li>
                ))}
              </ul>

              <h3>Company History</h3>
              <ul>
                {validCompanies.map((company, index) => (
                  <li key={`history-${index}`}>
                    {company.role} at {company.name} - {company.duration}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <button className="primary" onClick={downloadPdf} disabled={!resume}>
          Download PDF
        </button>
      </section>
    </main>
  );
}

export default App;
