function getMainProfileRoot() {
  return document.querySelector('.scaffold-layout__main, main, [role="main"]');
}

function getProfileTopCardRoot() {
  const mainRoot = getMainProfileRoot();
  const leftColumnBoundary = window.innerWidth * 0.7;

  const isValidTopCardContainer = (el) => {
    if (!el || el.closest('.scaffold-layout__aside, aside')) return false;
    if (mainRoot && !mainRoot.contains(el)) return false;

    const rect = el.getBoundingClientRect();
    if (rect.width < 260 || rect.height < 100) return false;
    if (rect.left > leftColumnBoundary) return false;
    return true;
  };

  for (const selector of SELECTORS.topCard) {
    const candidates = document.querySelectorAll(selector);
    for (const candidate of candidates) {
      if (!isValidTopCardContainer(candidate)) continue;
      return candidate;
    }
  }

  // Geometry fallback: choose the upper-left card in the main content area.
  const fallbackRoot = mainRoot || document;
  const fallbackCards = fallbackRoot.querySelectorAll('.artdeco-card, section');
  let bestCard = null;
  let bestScore = Infinity;
  for (const card of fallbackCards) {
    if (!isValidTopCardContainer(card)) continue;
    const rect = card.getBoundingClientRect();
    const score = (Math.max(rect.top, 0) * 2) + rect.left;
    if (score < bestScore) {
      bestScore = score;
      bestCard = card;
    }
  }
  if (bestCard) return bestCard;

  return mainRoot || null;
}

function getProfilePhotoSearchRoots() {
  const roots = [];
  const seen = new Set();

  const topCardRoot = getProfileTopCardRoot();
  if (topCardRoot) {
    roots.push(topCardRoot);
    seen.add(topCardRoot);
  }

  for (const selector of [...SELECTORS.profilePhotoContainer, ...SELECTORS.topCard]) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      if (!element || seen.has(element)) continue;
      if (!isInMainContent(element)) continue;
      seen.add(element);
      roots.push(element);
    }
  }

  return roots;
}

function isTrustedProfilePhotoSelector(selector) {
  return (SELECTORS.profilePhotoTopCard || []).includes(selector)
    || selector === 'img[src*="profile-displayphoto"]';
}

function pickBestProfilePhotoCandidate(searchRoots, minimumSize = 0) {
  const seenImages = new Set();
  let bestCandidate = null;
  const topCardRoot = getProfileTopCardRoot();
  const topCardRect = topCardRoot ? topCardRoot.getBoundingClientRect() : null;

  for (const root of searchRoots) {
    for (const selector of SELECTORS.profilePhoto) {
      const images = root.querySelectorAll(selector);
      for (const img of images) {
        if (seenImages.has(img)) continue;
        seenImages.add(img);

        if (img.offsetParent === null || !img.src || img.src.includes('ghost') || !isInMainContent(img)) {
          continue;
        }

        const rect = img.getBoundingClientRect();
        if (Math.max(rect.width, rect.height) < minimumSize) continue;
        if (Math.max(rect.width, rect.height) < 80) continue;

        const aspectRatio = rect.width / Math.max(rect.height, 1);
        const isSquareLike = aspectRatio >= 0.75 && aspectRatio <= 1.35;
        const isBannerLike = aspectRatio > 1.6 || aspectRatio < 0.6;
        const photoAnchor = findProfilePhotoAnchor(img);
        const hasProfileAnchor = Boolean(photoAnchor && photoAnchor !== img);
        const selectorLooksSpecific = isTrustedProfilePhotoSelector(selector);

        if (isBannerLike) {
          continue;
        }

        const area = rect.width * rect.height;
        const isNearTop = rect.top < window.innerHeight * 0.6;
        const isNearLeft = rect.left < window.innerWidth * 0.45;
        let score = area * (isNearTop ? 2 : 1);

        score *= isSquareLike ? 2.5 : 0.35;
        if (hasProfileAnchor) score *= 3;
        if (selectorLooksSpecific) score *= 2;
        if (isNearLeft) score *= 1.4;

        if (topCardRect) {
          const centerX = rect.left + (rect.width / 2);
          const centerY = rect.top + (rect.height / 2);
          const relX = (centerX - topCardRect.left) / Math.max(topCardRect.width, 1);
          const relY = (centerY - topCardRect.top) / Math.max(topCardRect.height, 1);

          // Real profile avatars usually sit on the left side of the top card.
          if (relX <= 0.35) {
            score *= 3;
          } else if (relX <= 0.55) {
            score *= 0.5;
          } else {
            score *= 0.12;
          }

          // Down-rank candidates that are unusually high/low in the top card.
          if (relY < 0.05 || relY > 0.95) {
            score *= 0.5;
          }
        }

        if (!bestCandidate || score > bestCandidate.score) {
          bestCandidate = { img, rect, score, selector, aspectRatio };
        }
      }
    }
  }

  return bestCandidate;
}

function findProfilePhotoImg() {
  const searchRoots = getProfilePhotoSearchRoots();
  const rootedCandidate = searchRoots.length ? pickBestProfilePhotoCandidate(searchRoots) : null;

  if (rootedCandidate) {
    debugLog(
      'findPhotoImg',
      `Found top-card photo via "${rootedCandidate.selector}" (${Math.round(rootedCandidate.rect.width)}x${Math.round(rootedCandidate.rect.height)}, ratio ${rootedCandidate.aspectRatio.toFixed(2)}, x=${Math.round(rootedCandidate.rect.left)}, y=${Math.round(rootedCandidate.rect.top)})`
    );
    return rootedCandidate.img;
  }

  const fallbackCandidate = pickBestProfilePhotoCandidate([document], MIN_MAIN_PROFILE_PHOTO_SIZE);
  if (fallbackCandidate) {
    debugLog(
      'findPhotoImg',
      `Fell back to largest visible photo via "${fallbackCandidate.selector}" (${Math.round(fallbackCandidate.rect.width)}x${Math.round(fallbackCandidate.rect.height)}, ratio ${fallbackCandidate.aspectRatio.toFixed(2)}, x=${Math.round(fallbackCandidate.rect.left)}, y=${Math.round(fallbackCandidate.rect.top)})`
    );
    return fallbackCandidate.img;
  }

  return null;
}

function findProfilePhotoAnchor(photoImg) {
  if (!photoImg) return null;
  const photoRect = photoImg.getBoundingClientRect();
  const maxAnchorWidth = Math.max(260, photoRect.width * 2.2);
  const maxAnchorHeight = Math.max(260, photoRect.height * 2.2);

  for (const selector of SELECTORS.profilePhotoContainer) {
    try {
      const anchor = photoImg.closest(selector);
      if (!anchor || !isInMainContent(anchor)) continue;

      const anchorRect = anchor.getBoundingClientRect();
      if (anchorRect.width <= 0 || anchorRect.height <= 0) continue;

      const aspectRatio = anchorRect.width / Math.max(anchorRect.height, 1);
      const isBannerLike = aspectRatio > 1.8 || aspectRatio < 0.55;
      const isOversized = anchorRect.width > maxAnchorWidth || anchorRect.height > maxAnchorHeight;
      if (isBannerLike || isOversized) continue;

      if (anchorRect.width > 0 && anchorRect.height > 0) {
        return anchor;
      }
    } catch (e) {}
  }

  return photoImg;
}

function findCardContainer(anchorEl) {
  if (!anchorEl) return null;
  const anchorRect = anchorEl.getBoundingClientRect();

  const matchesAnyTopCardSelector = (el) => {
    for (const selector of SELECTORS.topCard) {
      try {
        if (el.matches(selector)) return true;
      } catch (e) {}
    }
    return false;
  };

  const isValidCard = (el) => {
    if (!el || !isInMainContent(el) || el.closest('.scaffold-layout__aside, aside')) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 260 || rect.height < 120) return false;
    if (rect.width > window.innerWidth * 0.95) return false;

    // Candidate must actually bound the photo.
    const containsPhoto =
      anchorRect.left >= rect.left - 1 &&
      anchorRect.right <= rect.right + 1 &&
      anchorRect.top >= rect.top - 1 &&
      anchorRect.bottom <= rect.bottom + 1;
    if (!containsPhoto) return false;

    return true;
  };

  // Prefer the nearest ancestor that explicitly looks like a top-card container.
  let el = anchorEl.parentElement;
  for (let i = 0; i < 16 && el && el !== document.body; i++) {
    if (matchesAnyTopCardSelector(el) && isValidCard(el)) {
      const rect = el.getBoundingClientRect();
      debugLog('findCard', `Found top card ancestor at depth ${i}: ${el.tagName} (${Math.round(rect.width)}x${Math.round(rect.height)})`);
      return el;
    }
    el = el.parentElement;
  }

  // Fallback: nearest bounded card/section ancestor.
  el = anchorEl.parentElement;
  for (let i = 0; i < 16 && el && el !== document.body; i++) {
    const isCardLike = el.classList?.contains('artdeco-card') || el.tagName === 'SECTION';
    if (isCardLike && isValidCard(el)) {
      const rect = el.getBoundingClientRect();
      debugLog('findCard', `Found fallback card ancestor at depth ${i}: ${el.tagName} (${Math.round(rect.width)}x${Math.round(rect.height)})`);
      return el;
    }
    el = el.parentElement;
  }

  return null;
}

function unwrapNameAnchorWrapper(gmState) {
  if (gmState) {
    gmState._photoRef = null;
    gmState._cardRef = null;
  }

  const decoratedHeading = document.querySelector('[data-liebs-name-heading="true"]');
  if (decoratedHeading) {
    decoratedHeading.removeAttribute('data-liebs-name-heading');
    decoratedHeading.classList.remove('liebs-gif-name-heading--with-btn');
    decoratedHeading.style.removeProperty('--liebs-icon-left');
  }

  const nameAnchorWrapper = document.getElementById('liebs-gif-btn-name-anchor');
  if (nameAnchorWrapper) {
    nameAnchorWrapper.remove();
  }
}

function placeFloatingProfileButton(button, gmState, options = {}) {
  const photoImg = findProfilePhotoImg();
  if (!photoImg) return false;

  const card = findCardContainer(photoImg);
  if (!card) return false;

  const cardPosition = getComputedStyle(card).position;
  if (cardPosition === 'static') {
    card.style.position = 'relative';
  }

  const {
    wrapperId = 'liebs-gif-btn-wrapper',
    anchoredClassName = 'liebs-gif-btn--anchored',
    horizontalOffset = 0,
  } = options;

  button.classList.add(anchoredClassName);

  const wrapper = document.createElement('div');
  wrapper.id = wrapperId;
  wrapper.appendChild(button);
  card.appendChild(wrapper);

  const photoRect = photoImg.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const buttonHeight = button.offsetHeight || 28;
  const buttonWidth = button.offsetWidth || 28;
  const edgePadding = 8;
  const gap = 8;

  const preferredTopOffset = photoRect.top - cardRect.top - buttonHeight - gap;
  const preferredLeftOffset = (photoRect.left - cardRect.left + (photoRect.width / 2)) - (buttonWidth / 2) + horizontalOffset;

  const minLeftOffset = edgePadding;
  const maxLeftOffset = Math.max(minLeftOffset, cardRect.width - buttonWidth - edgePadding);
  const minTopOffset = edgePadding;
  const maxTopOffset = Math.max(minTopOffset, cardRect.height - buttonHeight - edgePadding);

  let topOffset = Math.max(minTopOffset, Math.min(preferredTopOffset, maxTopOffset));
  let leftOffset = Math.max(minLeftOffset, Math.min(preferredLeftOffset, maxLeftOffset));

  wrapper.style.position = 'absolute';
  wrapper.style.top = Math.round(topOffset) + 'px';
  wrapper.style.left = Math.round(leftOffset) + 'px';
  wrapper.style.width = Math.round(buttonWidth) + 'px';
  wrapper.style.height = Math.round(buttonHeight) + 'px';
  wrapper.style.display = 'flex';
  wrapper.style.alignItems = 'center';
  wrapper.style.justifyContent = 'center';
  wrapper.style.transform = 'none';
  wrapper.style.zIndex = '9999';

  // Correct for transformed/offset ancestor coordinate systems by measuring
  // actual viewport placement and nudging to the true photo center.
  const desiredViewportLeft = photoRect.left + (photoRect.width / 2) - (buttonWidth / 2) + horizontalOffset;
  const desiredViewportTop = photoRect.top - buttonHeight - gap;
  const placedRect = wrapper.getBoundingClientRect();
  const deltaX = desiredViewportLeft - placedRect.left;
  const deltaY = desiredViewportTop - placedRect.top;
  if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
    leftOffset = Math.max(minLeftOffset, Math.min(leftOffset + deltaX, maxLeftOffset));
    topOffset = Math.max(minTopOffset, Math.min(topOffset + deltaY, maxTopOffset));
    wrapper.style.left = Math.round(leftOffset) + 'px';
    wrapper.style.top = Math.round(topOffset) + 'px';
  }

  if (gmState) {
    gmState._photoRef = photoImg;
    gmState._cardRef = card;
  }

  debugLog(
    'placeButton',
    `Button anchored above photo at top=${Math.round(topOffset)}px left=${Math.round(leftOffset)}px (cardLeft=${Math.round(cardRect.left)}, photoLeft=${Math.round(photoRect.left)})`
  );
  return true;
}

function placeButtonAbovePhoto(button, gmState) {
  return placeFloatingProfileButton(button, gmState, {
    wrapperId: 'liebs-gif-btn-wrapper',
    anchoredClassName: 'liebs-gif-btn--anchored',
    horizontalOffset: 0,
  });
}
