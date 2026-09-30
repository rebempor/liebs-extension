// LinkedIn Liebs GIF Generator - Profile extraction helpers
// Content-script-only utilities for reading profile data from LinkedIn pages.

function extractProfilePhoto() {
  const topCardSelectors = SELECTORS.profilePhotoTopCard || SELECTORS.profilePhoto || [];

  for (const selector of topCardSelectors) {
    const img = document.querySelector(selector);
    if (img && img.src && img.src.includes('media.licdn.com') && !img.src.includes('ghost')) {
      return img.src;
    }
  }

  const allProfileImages = document.querySelectorAll('img[src*="profile-displayphoto"]');
  let largestImg = null;
  let largestSize = 0;

  for (const img of allProfileImages) {
    if (img.src.includes('ghost')) continue;
    const size = (img.naturalWidth || img.width) * (img.naturalHeight || img.height);
    const rect = img.getBoundingClientRect();
    const isInTopArea = rect.top < window.innerHeight * 0.6;
    const score = size * (isInTopArea ? 2 : 1);
    if (score > largestSize) {
      largestSize = score;
      largestImg = img;
    }
  }

  if (largestImg) return largestImg.src;

  for (const selector of SELECTORS.profilePhoto) {
    const img = document.querySelector(selector);
    if (img && img.src && !img.src.includes('ghost')) {
      return img.src;
    }
  }

  // Last-resort fallback: LinkedIn's OG image tag is generally stable even
  // when page class names change in A/B tests.
  const ogImageUrl = document.querySelector('meta[property="og:image"]')?.content || null;
  if (ogImageUrl && ogImageUrl.includes('licdn.com') && !ogImageUrl.includes('ghost')) {
    return ogImageUrl;
  }

  trackContentErrorOnce('dom.profile_photo_selector_failed', 'dom.selector_failed', new Error('Profile photo selector failed'), {
    selectorGroup: 'profilePhoto',
    pathname: window.location.pathname,
    selectorCount: SELECTORS.profilePhoto.length,
  });
  return null;
}

function isValidNameElement(element) {
  if (!element) return false;
  const root = element.getRootNode ? element.getRootNode() : null;
  if (root && typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) {
    return false;
  }
  if (!isInMainContent(element)) return false;
  if (element.offsetParent === null) return false;
  return true;
}

function normalizeNameText(text) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 60) return null;
  return normalized;
}

function extractFirstName() {
  // Try DOM selectors first (most reliable), then choose first valid main-profile match.
  for (const selector of SELECTORS.firstName) {
    try {
      const elements = deepQueryAll(selector);
      for (const element of elements) {
        if (!isValidNameElement(element) || !element.textContent) continue;
        const fullName = normalizeNameText(element.textContent);
        if (!fullName) continue;
        const firstName = fullName.split(/\s+/)[0];
        if (firstName && firstName.length > 1 && !firstName.includes('{')) {
          debugLog('extractName', `Found "${firstName}" via selector "${selector}"`);
          return firstName;
        }
      }
    } catch (e) {}
  }

  // Try h1 fallback in main content only.
  const h1Elements = deepQueryAll('h1');
  for (const nameEl of h1Elements) {
    if (!isValidNameElement(nameEl)) continue;
    const text = normalizeNameText(nameEl.textContent);
    if (text && text.length > 1) {
      const firstName = text.split(/\s+/)[0];
      if (firstName && firstName.length > 1) {
        debugLog('extractName', `Found "${firstName}" via h1 fallback`);
        return firstName;
      }
    }
  }

  // Page title fallback — LinkedIn titles are usually "Name - Headline | LinkedIn"
  try {
    const title = document.title;
    const titleMatch = title.match(/^(.+?)\s*(?:-|–|\|)\s*/);
    if (titleMatch) {
      const fullName = titleMatch[1].trim();
      const firstName = fullName.split(/\s+/)[0];
      if (firstName && firstName.length > 1 && firstName.length < 30) {
        debugLog('extractName', `Found "${firstName}" via page title`);
        return firstName;
      }
    }
  } catch (e) {}

  // URL slug fallback
  const urlMatch = window.location.pathname.match(/\/in\/([^/]+)/);
  if (urlMatch) {
    const slug = urlMatch[1].toLowerCase();
    let firstName = slug.split(/[-_]/)[0];
    if (firstName === slug && slug.length > 8) {
      const camelMatch = urlMatch[1].match(/^([A-Z][a-z]+)/);
      if (camelMatch) {
        firstName = camelMatch[1].toLowerCase();
      } else {
        debugLog('extractName', `URL slug "${slug}" too ambiguous, skipping`);
        return null;
      }
    }
    firstName = firstName.charAt(0).toUpperCase() + firstName.slice(1);
    debugLog('extractName', `URL fallback: "${firstName}"`);
    return firstName;
  }

  return null;
}

function extractLastName() {
  // Try DOM selectors (same ones as firstName)
  for (const selector of SELECTORS.firstName) {
    try {
      const elements = deepQueryAll(selector);
      for (const element of elements) {
        if (!isValidNameElement(element) || !element.textContent) continue;
        const fullName = normalizeNameText(element.textContent);
        if (!fullName) continue;
        const parts = fullName.split(/\s+/);
        if (parts.length >= 2) {
          const lastName = parts.slice(1).join(' ');
          if (lastName.length > 0 && !lastName.includes('{')) {
            debugLog('extractLastName', `Found "${lastName}" via selector "${selector}"`);
            return lastName;
          }
        }
      }
    } catch (e) {}
  }

  // Try h1 fallback in main content only.
  const h1Elements = deepQueryAll('h1');
  for (const nameEl of h1Elements) {
    if (!isValidNameElement(nameEl)) continue;
    const text = normalizeNameText(nameEl.textContent);
    if (text && text.length > 1 && text.length < 60) {
      const parts = text.split(/\s+/);
      if (parts.length >= 2) {
        const lastName = parts.slice(1).join(' ');
        if (lastName.length > 0) {
          debugLog('extractLastName', `Found "${lastName}" via h1 fallback`);
          return lastName;
        }
      }
    }
  }

  // Page title fallback
  try {
    const title = document.title;
    const titleMatch = title.match(/^(.+?)\s*[-\u2013|]/);
    if (titleMatch) {
      const fullName = titleMatch[1].trim();
      const parts = fullName.split(/\s+/);
      if (parts.length >= 2) {
        const lastName = parts.slice(1).join(' ');
        if (lastName.length > 0 && lastName.length < 30) {
          debugLog('extractLastName', `Found "${lastName}" via page title`);
          return lastName;
        }
      }
    }
  } catch (e) {}

  // No URL slug fallback — too unreliable for last names
  return null;
}

function normalizeRoleText(text, maxLength = 200) {
  const normalized = (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[•·]/g, ' | ')
    .replace(/\s+/g, ' ')
    .replace(/\s+\|\s+/g, ' | ')
    .trim();

  if (!normalized || normalized.length > maxLength || normalized.includes('{')) {
    return null;
  }

  return normalized;
}

function cleanJobTitleText(text) {
  const normalized = normalizeRoleText(text, 120);
  if (!normalized) return null;
  if (/^(experience|show all|see all|see more|show more|linkedin)$/i.test(normalized)) return null;
  if (/\b\d+\s+(followers|connections?)\b/i.test(normalized)) return null;
  return normalized;
}

function cleanCompanyText(text) {
  const normalized = normalizeRoleText(text, 100);
  if (!normalized) return null;

  const cleaned = normalized.split(' | ')[0].trim();
  if (!cleaned) return null;
  if (/^(experience|linkedin)$/i.test(cleaned)) return null;
  if (/\b\d+\s+(followers|connections?)\b/i.test(cleaned)) return null;
  if (/\b\d{4}\b/.test(cleaned)) return null;
  return cleaned;
}

function looksLowSignalJobTitle(text) {
  if (!text) return false;
  return /\b(open to work|helping|seeking|looking for|building|advising|investing|creator)\b/i.test(text);
}

function isLikelyTimelineText(text) {
  if (!text) return false;
  return /\b\d{4}\b/.test(text) || /\b(present|current|yrs?|years?|mos?|months?)\b/i.test(text);
}

function splitRoleSegments(text) {
  return (text || '')
    .split(/\s+\|\s+|\s+-\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRoleText(text, fallbackCompany = null) {
  const normalized = normalizeRoleText(text);
  const fallback = cleanCompanyText(fallbackCompany);
  let jobTitle = null;
  let company = fallback;

  if (!normalized) {
    return { jobTitle: null, company };
  }

  const directMatch = normalized.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (directMatch) {
    return {
      jobTitle: cleanJobTitleText(directMatch[1]),
      company: company || cleanCompanyText(directMatch[2]),
    };
  }

  const segments = splitRoleSegments(normalized);
  if (company) {
    const lowerCompany = company.toLowerCase();
    const titleSegment = segments.find((segment) => segment.toLowerCase() !== lowerCompany);
    if (titleSegment) {
      jobTitle = cleanJobTitleText(titleSegment);
    }

    if (!jobTitle) {
      const companyPattern = new RegExp(`\\b${escapeRegExp(company)}\\b`, 'i');
      if (companyPattern.test(normalized)) {
        const stripped = normalized
          .replace(companyPattern, '')
          .replace(/\s+(?:at|@)\s+/i, ' ')
          .replace(/\s+\|\s+/g, ' ')
          .replace(/\s+-\s+/g, ' ')
          .trim();
        jobTitle = cleanJobTitleText(stripped);
      }
    }
  }

  if (!jobTitle && segments.length > 1) {
    jobTitle = cleanJobTitleText(segments[0]);
    if (!company) {
      company = cleanCompanyText(segments[1]);
    }
  }

  if (!jobTitle) {
    jobTitle = cleanJobTitleText(normalized);
  }

  return { jobTitle, company };
}

function buildRoleCandidate(source, confidence, jobTitleText, companyText) {
  const jobTitle = cleanJobTitleText(jobTitleText);
  const company = cleanCompanyText(companyText);
  if (!jobTitle && !company) return null;
  return {
    jobTitle,
    company,
    source,
    confidence,
  };
}

function scoreRoleCandidate(candidate) {
  let confidence = candidate.confidence || 0;

  if (candidate.jobTitle && candidate.company) confidence += 0.12;
  if (candidate.source === 'experience_section' && candidate.jobTitle && candidate.company) confidence += 0.12;
  if (!candidate.jobTitle) confidence -= 0.45;
  if (!candidate.company) confidence -= 0.08;
  if (candidate.jobTitle && candidate.jobTitle.length > 90) confidence -= 0.12;
  if (candidate.jobTitle && looksLowSignalJobTitle(candidate.jobTitle)) confidence -= 0.28;
  if (candidate.company && candidate.jobTitle && candidate.company.toLowerCase() === candidate.jobTitle.toLowerCase()) {
    confidence -= 0.25;
  }

  return {
    ...candidate,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

function pickBestRoleCandidate(candidates) {
  const seen = new Set();
  const scored = [];

  for (const candidate of candidates) {
    if (!candidate || (!candidate.jobTitle && !candidate.company)) continue;
    const key = `${candidate.jobTitle || ''}::${candidate.company || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push(scoreRoleCandidate(candidate));
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  return scored[0] || null;
}

function pushRoleCandidate(candidates, candidate) {
  if (!candidate) return;
  debugLog('extractCurrentRole', `Candidate from ${candidate.source}:`, candidate);
  candidates.push(candidate);
}

function getTopCardElement() {
  for (const selector of SELECTORS.topCard) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function extractVisibleHeadlineText() {
  const headlineSelectors = [
    '.text-body-medium.break-words',
    'div.text-body-medium[data-anonymize="headline"]',
    '[data-anonymize="headline"]',
    '.pv-top-card--list .text-body-medium',
  ];

  for (const selector of headlineSelectors) {
    try {
      const element = deepQuery(selector);
      if (!element || !element.textContent || !isInMainContent(element)) continue;
      const text = normalizeRoleText(element.textContent);
      if (text) {
        debugLog('extractCurrentRole', `Found intro text "${text}" via selector "${selector}"`);
        return text;
      }
    } catch (e) {}
  }

  return null;
}

function extractCurrentCompanyText() {
  const topCard = getTopCardElement();
  const searchRoots = [topCard || document];

  for (const root of searchRoots) {
    const companyLink = root.querySelector('a[href*="/company/"]');
    const linkedCompany = cleanCompanyText(companyLink?.textContent);
    if (linkedCompany) {
      debugLog('extractCurrentRole', `Found company "${linkedCompany}" via company link`);
      return linkedCompany;
    }
  }

  const companySelectors = [
    'button[aria-label*="Current company"] span',
    '.pv-top-card--experience-list-item',
    'div.inline-show-more-text span[aria-hidden="true"]',
  ];

  for (const root of searchRoots) {
    for (const selector of companySelectors) {
      try {
        const element = root.querySelector(selector);
        if (!element || !element.textContent) continue;
        if (root === document && !isInMainContent(element)) continue;
        const company = cleanCompanyText(element.textContent);
        if (company) {
          debugLog('extractCurrentRole', `Found company "${company}" via selector "${selector}"`);
          return company;
        }
      } catch (e) {}
    }
  }

  return null;
}

function findExperienceSection() {
  const experienceAnchor = document.getElementById('experience')
    || document.querySelector('a[id="experience"], div[id="experience"]');
  const anchoredSection = experienceAnchor?.closest('section');
  if (anchoredSection) return anchoredSection;

  const sections = Array.from(document.querySelectorAll('section'));
  for (const section of sections) {
    const headingText = normalizeRoleText(section.querySelector('h2')?.textContent || '', 80);
    if (headingText && /^experience$/i.test(headingText)) {
      return section;
    }

    const text = normalizeRoleText((section.innerText || '').slice(0, 240), 240);
    if (text && /^experience\b/i.test(text)) {
      return section;
    }
  }

  return null;
}

function extractMeaningfulRoleLines(rawText) {
  const seen = new Set();
  const lines = [];

  for (const rawLine of (rawText || '').split('\n')) {
    const line = normalizeRoleText(rawLine, 140);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    if (/^(experience|show all|see more|show more|message|follow|connect)$/i.test(line)) continue;
    lines.push(line);
  }

  return lines;
}

function extractExperienceCandidates(defaultCompany = null) {
  const section = findExperienceSection();
  if (!section) return [];

  const candidates = [];
  const blocks = Array.from(section.querySelectorAll('li, .artdeco-list__item, .pvs-entity, [data-view-name]'));

  for (const block of blocks.slice(0, 12)) {
    const blockText = block.innerText || block.textContent || '';
    if (!blockText.trim()) continue;

    const lines = extractMeaningfulRoleLines(blockText);
    if (!lines.length) continue;

    let company = cleanCompanyText(block.querySelector('a[href*="/company/"]')?.textContent) || cleanCompanyText(defaultCompany);
    let jobTitle = null;
    const directLine = lines.find((line) => /\s+(?:at|@)\s+/i.test(line));

    if (directLine) {
      const parsed = parseRoleText(directLine, company);
      jobTitle = parsed.jobTitle;
      company = parsed.company || company;
    }

    const usefulLines = lines.filter((line) => !isLikelyTimelineText(line));
    if (!jobTitle) {
      for (const line of usefulLines) {
        const titleCandidate = cleanJobTitleText(line);
        if (!titleCandidate) continue;
        if (company && titleCandidate.toLowerCase() === company.toLowerCase()) continue;
        jobTitle = titleCandidate;
        break;
      }
    }

    if (!company && usefulLines.length > 1) {
      for (let i = 1; i < usefulLines.length; i += 1) {
        const companyCandidate = cleanCompanyText(usefulLines[i]);
        if (!companyCandidate) continue;
        if (jobTitle && companyCandidate.toLowerCase() === jobTitle.toLowerCase()) continue;
        company = companyCandidate;
        break;
      }
    }

    const candidate = buildRoleCandidate(
      'experience_section',
      /\bpresent\b/i.test(blockText) ? 0.78 : 0.66,
      jobTitle,
      company,
    );
    pushRoleCandidate(candidates, candidate);
  }

  return candidates;
}

function extractTopCardCandidates(defaultCompany = null) {
  const candidates = [];
  const headlineText = extractVisibleHeadlineText();
  const company = cleanCompanyText(defaultCompany) || extractCurrentCompanyText();

  if (!headlineText && !company) return candidates;

  const parsed = parseRoleText(headlineText, company);
  pushRoleCandidate(
    candidates,
    buildRoleCandidate('top_card', company ? 0.62 : 0.5, parsed.jobTitle, parsed.company || company),
  );

  return candidates;
}

function extractDocumentTitleCandidates(defaultCompany = null) {
  const candidates = [];

  try {
    const title = document.title;
    const match = title.match(/^.+?\s*[-\u2013]\s*(.+?)\s*\|?\s*LinkedIn/i);
    if (!match) return candidates;

    const parsed = parseRoleText(match[1].trim(), defaultCompany);
    pushRoleCandidate(
      candidates,
      buildRoleCandidate('document_title', defaultCompany ? 0.44 : 0.38, parsed.jobTitle, parsed.company || defaultCompany),
    );
  } catch (e) {}

  return candidates;
}

function extractMetaDescriptionCandidates(defaultCompany = null) {
  const candidates = [];

  try {
    const metaDesc = document.querySelector('meta[name="description"]')?.content
      || document.querySelector('meta[property="og:description"]')?.content;
    if (!metaDesc) return candidates;

    const detailMatch = metaDesc.match(/^.+?\s*[-\u2013]\s*(.+)$/);
    const detailText = detailMatch ? detailMatch[1] : metaDesc;
    const parts = detailText
      .split(/\.\s+/)
      .map((part) => normalizeRoleText(part, 140))
      .filter(Boolean);

    const fallbackCompany = cleanCompanyText(parts[1]) || cleanCompanyText(defaultCompany);
    const parsed = parseRoleText(parts[0], fallbackCompany);
    pushRoleCandidate(
      candidates,
      buildRoleCandidate('meta_description', fallbackCompany ? 0.4 : 0.34, parsed.jobTitle, parsed.company || fallbackCompany),
    );
  } catch (e) {}

  return candidates;
}

function extractCurrentRole() {
  const defaultCompany = extractCurrentCompanyText();
  const candidates = [
    ...extractExperienceCandidates(defaultCompany),
    ...extractTopCardCandidates(defaultCompany),
    ...extractDocumentTitleCandidates(defaultCompany),
    ...extractMetaDescriptionCandidates(defaultCompany),
  ];

  const best = pickBestRoleCandidate(candidates);

  if (!best) {
    trackContentErrorOnce(
      'dom.current_role_selector_failed',
      'dom.selector_failed',
      new Error('Current role extraction failed'),
      {
        selectorGroup: 'currentRole',
        pathname: window.location.pathname,
        candidateCount: candidates.length,
      },
    );
    return null;
  }

  if (!best.jobTitle || !best.company) {
    trackContentErrorOnce(
      'dom.current_role_partial',
      'dom.selector_partial',
      new Error('Current role extraction partial'),
      {
        selectorGroup: 'currentRole',
        pathname: window.location.pathname,
        source: best.source,
        titleFound: !!best.jobTitle,
        companyFound: !!best.company,
        confidence: best.confidence,
      },
    );
  } else if (best.confidence < 0.55) {
    trackContentErrorOnce(
      'dom.current_role_low_confidence',
      'dom.selector_low_confidence',
      new Error('Current role extraction low confidence'),
      {
        selectorGroup: 'currentRole',
        pathname: window.location.pathname,
        source: best.source,
        confidence: best.confidence,
      },
    );
  }

  debugLog('extractCurrentRole', 'Selected role:', best);
  return best;
}

function extractHeadline() {
  // Compatibility alias: downstream code still expects the key to be named "headline".
  return extractCurrentRole()?.jobTitle || null;
}

function extractCompany() {
  return extractCurrentRole()?.company || null;
}

function extractProfileData() {
  const currentRole = extractCurrentRole();

  return {
    photoUrl: extractProfilePhoto(),
    firstName: extractFirstName(),
    lastName: extractLastName(),
    headline: currentRole?.jobTitle || null,
    company: currentRole?.company || null,
    profileUrl: window.location.href,
    timestamp: Date.now()
  };
}

async function imageUrlToBase64(url) {
  try {
    const response = await fetchWithTimeout(url, {}, 15000);
    if (!response.ok) {
      throw new Error(`Failed to fetch image (HTTP ${response.status})`);
    }
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('[Liebs GIF] Failed to convert image to base64:', error);
    return null;
  }
}

function normalizePhotoUrlForFingerprint(photoUrl) {
  if (typeof photoUrl !== 'string') return '';
  const trimmed = photoUrl.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    return parsed.toString();
  } catch (_err) {
    return trimmed;
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function computePhotoFingerprint(photoUrl) {
  const normalizedUrl = normalizePhotoUrlForFingerprint(photoUrl);
  if (!normalizedUrl) return null;

  if (!window.crypto?.subtle) {
    debugWarn('fingerprint', 'Web Crypto API unavailable; skipping fingerprint.');
    return null;
  }

  const encoded = new TextEncoder().encode(normalizedUrl);
  const digest = await window.crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(digest));
}
