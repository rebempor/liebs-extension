function positionFloatingProfileButtonAfterCollapse(options = {}) {
  const {
    buttonId,
    wrapperId,
    anchoredClassName,
    floatingClassName,
    manualPosition,
    manualPositionPath,
  } = options;

  const triggerBtn = document.getElementById(buttonId);
  const wrapper = document.getElementById(wrapperId);
  if (!triggerBtn) return;

  // Photo-anchored mode should stay attached to the profile card.
  // Do not remap it to manual sidecar coordinates.
  if (wrapper && triggerBtn.classList.contains(anchoredClassName)) {
    wrapper.style.position = 'absolute';
    wrapper.style.right = 'auto';
    wrapper.style.bottom = 'auto';
    wrapper.style.transform = 'none';
    wrapper.style.zIndex = '9999';
    return;
  }

  const sameProfileAsLastDrag =
    Boolean(manualPositionPath) &&
    manualPositionPath === window.location.pathname;

  if (!manualPosition || !sameProfileAsLastDrag) {
    return;
  }

  const left = Math.round(manualPosition.left);
  const top = Math.round(manualPosition.top);

  if (wrapper) {
    wrapper.style.position = 'fixed';
    wrapper.style.left = left + 'px';
    wrapper.style.top = top + 'px';
    wrapper.style.right = 'auto';
    wrapper.style.bottom = 'auto';
    wrapper.style.transform = 'none';
    wrapper.style.zIndex = '9999';
    return;
  }

  triggerBtn.classList.remove(anchoredClassName);
  triggerBtn.classList.add(floatingClassName);
  triggerBtn.style.left = left + 'px';
  triggerBtn.style.top = top + 'px';
  triggerBtn.style.right = 'auto';
  triggerBtn.style.bottom = 'auto';
}

function positionTriggerButtonAfterSidecarCollapse(gmState) {
  positionFloatingProfileButtonAfterCollapse({
    buttonId: 'liebs-gif-btn',
    wrapperId: 'liebs-gif-btn-wrapper',
    anchoredClassName: 'liebs-gif-btn--anchored',
    floatingClassName: 'liebs-gif-btn--floating',
    manualPosition: gmState?.manualPosition,
    manualPositionPath: gmState?.manualPositionPath,
  });
}

function getTriggerButtonIdleMarkup() {
  return '';
}

function setTriggerButtonBusy(isBusy) {
  const triggerBtn = document.getElementById('liebs-gif-btn');
  if (!triggerBtn) return;

  triggerBtn.disabled = false;

  if (isBusy) {
    triggerBtn.classList.add('is-busy');
    triggerBtn.setAttribute('aria-busy', 'true');
    triggerBtn.innerHTML = '<div class="loading" aria-hidden="true"></div>';
    return;
  }

  triggerBtn.classList.remove('is-busy');
  triggerBtn.removeAttribute('aria-busy');
  triggerBtn.innerHTML = getTriggerButtonIdleMarkup();
}

function setTriggerButtonExpanded(isExpanded) {
  const triggerBtn = document.getElementById('liebs-gif-btn');
  if (!triggerBtn) return;
  triggerBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
}

function setTriggerButtonVisible(isVisible) {
  const triggerBtn = document.getElementById('liebs-gif-btn');
  if (!triggerBtn) return;
  triggerBtn.classList.toggle('gm-trigger-hidden', !isVisible);
}

function positionVideoTriggerButtonAfterSidecarCollapse(vsState) {
  positionFloatingProfileButtonAfterCollapse({
    buttonId: 'liebs-video-btn',
    wrapperId: 'liebs-video-btn-wrapper',
    anchoredClassName: 'liebs-video-btn--anchored',
    floatingClassName: 'liebs-video-btn--floating',
    manualPosition: vsState?.manualPosition,
    manualPositionPath: vsState?.manualPositionPath,
  });
}

function setVideoTriggerButtonExpanded(isExpanded) {
  const triggerBtn = document.getElementById('liebs-video-btn');
  if (!triggerBtn) return;
  triggerBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
}

function setVideoTriggerButtonVisible(isVisible) {
  const triggerBtn = document.getElementById('liebs-video-btn');
  if (!triggerBtn) return;
  triggerBtn.classList.toggle('vs-trigger-hidden', !isVisible);
}
