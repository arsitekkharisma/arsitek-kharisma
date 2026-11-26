'use strict';

(() => {
  const list = document.querySelector('.projects-list');
  if (!list) return;

  function createProjectCard(project) {
    const card = document.createElement('article');
    card.className = 'drawing-sheet imported-project';
    const viewport = document.createElement('div');
    viewport.className = 'viewport-box';
    const badge = document.createElement('div');
    badge.className = 'status-badge';
    badge.textContent = 'MODEL · DENAH OTOMATIS';
    const preview = document.createElement('img');
    preview.className = 'imported-preview';
    preview.src = project.previewUrl;
    preview.alt = `Pratinjau model ${project.title}`;
    const planLayer = document.createElement('div');
    planLayer.className = 'layer-plan imported-plan';
    const planImage = document.createElement('img');
    planImage.src = `/api/projects/${encodeURIComponent(project.id)}/plans/denah-lantai-1.svg`;
    planImage.alt = `Denah ${project.title}`;
    planLayer.append(planImage);
    viewport.append(badge, preview, planLayer);
    preview.classList.add('layer-model');
    viewport.addEventListener('mouseenter', () => {
      badge.textContent = 'DENAH · POTONGAN OTOMATIS';
    });
    viewport.addEventListener('mouseleave', () => {
      if (!card.classList.contains('show-plan')) badge.textContent = 'MODEL · DENAH OTOMATIS';
    });
    viewport.addEventListener('click', () => {
      const showing = card.classList.toggle('show-plan');
      badge.textContent = showing ? 'DENAH · POTONGAN OTOMATIS' : 'MODEL · DENAH OTOMATIS';
    });

    const titleBlock = document.createElement('div');
    titleBlock.className = 'title-block';
    const sheetCell = document.createElement('div');
    sheetCell.className = 'tb-cell';
    const sheetLabel = document.createElement('span');
    sheetLabel.className = 'tb-label';
    sheetLabel.textContent = 'Proyek';
    const sheetNumber = document.createElement('span');
    sheetNumber.className = 'sheet-number';
    sheetNumber.textContent = String(project.metadata.floorCount).padStart(2, '0');
    sheetCell.append(sheetLabel, sheetNumber);

    const projectCell = document.createElement('div');
    projectCell.className = 'tb-cell';
    const heading = document.createElement('h2');
    heading.className = 'project-title';
    heading.textContent = project.title;
    const details = document.createElement('span');
    details.className = 'project-meta';
    details.textContent = [project.location, project.description].filter(Boolean).join(' · ');
    const link = document.createElement('a');
    link.href = `/project/${encodeURIComponent(project.id)}`;
    link.textContent = 'Lihat model dan denah →';
    link.style.cssText = 'color: var(--accent-orange); text-decoration: none;';
    projectCell.append(heading, details, link);

    const yearCell = document.createElement('div');
    yearCell.className = 'tb-cell';
    const yearLabel = document.createElement('span');
    yearLabel.className = 'tb-label';
    yearLabel.textContent = 'Tahun';
    const year = document.createElement('span');
    year.className = 'project-year';
    year.textContent = String(project.year);
    yearCell.append(yearLabel, year);
    titleBlock.append(sheetCell, projectCell, yearCell);
    card.append(viewport, titleBlock);
    return card;
  }

  fetch('/api/projects', { credentials: 'same-origin' })
    .then(async response => {
      if (!response.ok) throw new Error(`Daftar proyek gagal dimuat (${response.status}).`);
      return response.json();
    })
    .then(result => result.projects.forEach(project => list.append(createProjectCard(project))))
    .catch(error => {
      const notice = document.createElement('p');
      notice.className = 'project-load-error';
      notice.textContent = error.message;
      list.prepend(notice);
    });
})();
