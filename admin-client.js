'use strict';

(() => {
  const loginPanel = document.getElementById('login-panel');
  const dashboard = document.getElementById('dashboard');
  const loginForm = document.getElementById('login-form');
  const uploadForm = document.getElementById('upload-form');
  const loginStatus = document.getElementById('login-status');
  const uploadStatus = document.getElementById('upload-status');
  const projectStatus = document.getElementById('project-status');
  const projectList = document.getElementById('project-list');
  const uploadButton = document.getElementById('upload-button');
  const adminIdentity = document.getElementById('admin-identity');

  function showStatus(element, message, isError) {
    element.textContent = message;
    element.classList.toggle('error', isError);
    element.classList.toggle('success', !isError && Boolean(message));
  }

  async function api(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Permintaan gagal (${response.status}).`);
    return payload;
  }

  function displayAuthenticated(username) {
    loginPanel.hidden = true;
    dashboard.hidden = false;
    adminIdentity.textContent = `Masuk sebagai ${username}`;
    loadProjects();
  }

  async function checkSession() {
    try {
      const state = await api('/api/auth/me');
      if (state.authenticated) displayAuthenticated(state.username);
    } catch (error) {
      showStatus(loginStatus, error.message, true);
    }
  }

  function addText(parent, tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    parent.append(element);
    return element;
  }

  function createProjectCard(project) {
    const card = document.createElement('article');
    card.className = 'project-card';
    card.dataset.projectId = project.id;
    const heading = addText(card, 'h2', project.title);
    heading.title = project.title;
    const preview = document.createElement('img');
    preview.src = `/api/admin/projects/${encodeURIComponent(project.id)}/preview.svg`;
    preview.alt = `Pratinjau ${project.title}`;
    card.append(preview);

    const dimensions = project.metadata.dimensions;
    addText(card, 'p',
      `Ukuran model: ${dimensions.width.toFixed(2)} × ${dimensions.depth.toFixed(2)} × ${dimensions.height.toFixed(2)} m`,
      'small-mono');
    const floorDetection = project.metadata.floorSource === 'sketchup-manifest'
      ? 'berdasarkan grup SketchUp'
      : `perkiraan ${project.metadata.estimatedFloorCount}`;
    addText(card, 'p',
      `Denah dibuat: ${project.metadata.floorCount} lantai (${floorDetection}). ` +
      `${project.metadata.triangleCount.toLocaleString('id-ID')} bidang segitiga.`,
      'small-mono');
    const compression = project.originalSize
      ? Math.max(0, (1 - project.compressedSize / project.originalSize) * 100).toFixed(1)
      : '0.0';
    addText(card, 'p',
      `File asli ${(project.originalSize / 1024 / 1024).toFixed(2)} MB · versi web ${(project.compressedSize / 1024 / 1024).toFixed(2)} MB` +
      (project.deliveryGzip ? ` (gzip, ${compression}% lebih kecil)` : ' (asli dipakai karena kompresi tidak menghemat ukuran)'),
      'small-mono');

    const form = document.createElement('form');
    form.className = 'form-grid project-edit-form';
    form.innerHTML = `
      <label>Nama<input name="title" maxlength="100" required></label>
      <label>Lokasi<input name="location" maxlength="120"></label>
      <label>Tahun<input name="year" type="number" min="1800" max="2200" required></label>
      <label>Jumlah lantai<input name="floorCount" type="number" min="1" max="12" required></label>
      <label>Arah utara (derajat)<input name="northDegrees" type="number" min="0" max="359.99" step="0.1" required></label>
      <label class="full-width">Nama lantai (satu per baris)<textarea name="floorLabels"></textarea></label>
      <label class="check-row"><input name="isPublic" type="checkbox"> Publik</label>
      <label class="full-width">Deskripsi<textarea name="description" maxlength="500"></textarea></label>
      <div class="full-width form-actions">
        <button type="submit">Simpan pengaturan</button>
        <button type="button" class="secondary ai-button">Minta saran AI</button>
        <label class="check-row ai-consent"><input type="checkbox"> Izinkan pengiriman metadata AI</label>
      </div>
      <p class="status full-width ai-result" role="status" aria-live="polite"></p>
    `;
    const formFields = form.elements;
    formFields.title.value = project.title;
    formFields.location.value = project.location || '';
    formFields.year.value = project.year;
    formFields.floorCount.value = project.metadata.floorCount;
    formFields.northDegrees.value = project.metadata.northDegrees;
    formFields.floorLabels.value = project.floors.map(floor => floor.title).join('\n');
    formFields.description.value = project.description || '';
    formFields.isPublic.checked = project.isPublic;
    form.addEventListener('submit', event => saveProject(event, project.id, form));
    form.querySelector('.ai-button').addEventListener('click', () =>
      requestAiSuggestions(project.id, form)
    );
    card.append(form);

    const planStrip = document.createElement('div');
    planStrip.className = 'plan-strip';
    project.floors.forEach(floor => {
      const image = document.createElement('img');
      image.src = `/api/admin/projects/${encodeURIComponent(project.id)}/plans/denah-lantai-${floor.index + 1}.svg`;
      image.alt = `Denah ${floor.title}`;
      image.title = `${floor.title}, elevasi ${floor.elevation.toFixed(2)} meter`;
      planStrip.append(image);
    });
    card.append(planStrip);

    const shareActions = document.createElement('div');
    shareActions.className = 'card-actions';
    const days = document.createElement('input');
    days.type = 'number';
    days.min = '1';
    days.max = '365';
    days.value = '30';
    days.setAttribute('aria-label', 'Masa berlaku tautan dalam hari');
    days.style.width = '110px';
    shareActions.append(days);
    const shareButton = document.createElement('button');
    shareButton.type = 'button';
    shareButton.textContent = 'Buat tautan klien';
    shareButton.addEventListener('click', () => createShareLink(project.id, days.value, card));
    shareActions.append(shareButton);
    if (project.shareLinks.length > 0) {
      const revokeButton = document.createElement('button');
      revokeButton.type = 'button';
      revokeButton.className = 'danger';
      revokeButton.textContent = 'Cabut semua tautan';
      revokeButton.addEventListener('click', () => revokeShareLinks(project.id));
      shareActions.append(revokeButton);
    }
    const download = document.createElement('a');
    download.className = 'button-link secondary';
    download.href = `/api/admin/projects/${encodeURIComponent(project.id)}/original.glb`;
    download.textContent = 'Unduh GLB asli';
    shareActions.append(download);
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'danger';
    deleteButton.textContent = 'Hapus';
    deleteButton.addEventListener('click', () => deleteProject(project.id, project.title));
    shareActions.append(deleteButton);
    card.append(shareActions);
    return card;
  }

  async function loadProjects() {
    projectList.replaceChildren();
    showStatus(projectStatus, 'Memuat proyek…', false);
    try {
      const result = await api('/api/admin/projects');
      if (result.projects.length === 0) {
        showStatus(projectStatus, 'Belum ada model yang diimpor.', false);
        return;
      }
      showStatus(projectStatus, '', false);
      result.projects.forEach(project => projectList.append(createProjectCard(project)));
    } catch (error) {
      showStatus(projectStatus, error.message, true);
    }
  }

  async function saveProject(event, id, form) {
    event.preventDefault();
    const values = new FormData(form);
    const body = Object.fromEntries(values.entries());
    body.isPublic = form.elements.isPublic.checked;
    body.floorCount = Number(body.floorCount);
    body.northDegrees = Number(body.northDegrees);
    body.year = Number(body.year);
    body.floorLabels = form.elements.floorLabels.value.split(/\r?\n/u).map(label => label.trim()).filter(Boolean);
    try {
      await api(`/api/admin/projects/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      showStatus(form.querySelector('.ai-result'), 'Pengaturan dan denah berhasil diperbarui.', false);
      await loadProjects();
    } catch (error) {
      showStatus(form.querySelector('.ai-result'), error.message, true);
    }
  }

  async function requestAiSuggestions(id, form) {
    const result = form.querySelector('.ai-result');
    if (!form.querySelector('.ai-consent input').checked) {
      showStatus(result,
        'Centang izin terlebih dahulu. Hanya nama komponen, ukuran, dan informasi lantai yang dikirim, bukan file GLB.',
        true);
      return;
    }
    const button = form.querySelector('.ai-button');
    button.disabled = true;
    showStatus(result, 'Meminta saran AI…', false);
    try {
      const answer = await api(`/api/admin/projects/${encodeURIComponent(id)}/ai-suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: true })
      });
      form.elements.title.value = answer.suggestions.title;
      form.elements.description.value = answer.suggestions.description;
      form.elements.floorLabels.value = answer.suggestions.floorLabels.join('\n');
      showStatus(result,
        `${answer.note} Label lantai: ${answer.suggestions.floorLabels.join(', ')}. Simpan perubahan setelah memeriksa.`,
        false);
    } catch (error) {
      showStatus(result, error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function createShareLink(id, expiresDays, card) {
    try {
      const result = await api(`/api/admin/projects/${encodeURIComponent(id)}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresDays: Number(expiresDays) })
      });
      let output = card.querySelector('.share-output');
      if (!output) {
        output = document.createElement('p');
        output.className = 'share-output small-mono';
        card.append(output);
      }
      output.textContent = `Salin tautan ini untuk klien (berlaku sampai ${new Date(result.expiresAt).toLocaleString('id-ID')}): ${result.url}`;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(result.url);
          output.textContent += ' · tautan sudah disalin.';
        } catch {
          output.textContent += ' · salin tautan secara manual.';
        }
      } else {
        output.textContent += ' · salin tautan secara manual.';
      }
    } catch (error) {
      showStatus(projectStatus, error.message, true);
    }
  }

  async function revokeShareLinks(id) {
    if (!window.confirm('Cabut semua tautan klien untuk proyek ini?')) return;
    try {
      await api(`/api/admin/projects/${encodeURIComponent(id)}/share`, { method: 'DELETE' });
      await loadProjects();
    } catch (error) {
      showStatus(projectStatus, error.message, true);
    }
  }

  async function deleteProject(id, title) {
    if (!window.confirm(`Hapus proyek "${title}" beserta file GLB dan denahnya? Tindakan ini tidak dapat dibatalkan.`)) return;
    try {
      await api(`/api/admin/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadProjects();
    } catch (error) {
      showStatus(projectStatus, error.message, true);
    }
  }

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = loginForm.querySelector('button[type="submit"]');
    button.disabled = true;
    showStatus(loginStatus, 'Memeriksa kredensial…', false);
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(loginForm).entries()))
      });
      loginForm.reset();
      displayAuthenticated(result.username);
    } catch (error) {
      showStatus(loginStatus, error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('logout-button').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      dashboard.hidden = true;
      loginPanel.hidden = false;
      showStatus(loginStatus, 'Anda telah keluar.', false);
    } catch (error) {
      showStatus(projectStatus, error.message, true);
    }
  });

  uploadForm.elements.floorManifest.addEventListener('change', async event => {
    const file = event.currentTarget.files[0];
    const floorCountInput = uploadForm.elements.floorCount;
    const northInput = uploadForm.elements.northDegrees;
    if (!file) {
      floorCountInput.readOnly = false;
      northInput.readOnly = false;
      return;
    }
    try {
      const manifest = JSON.parse(await file.text());
      const floors = manifest?.floors;
      if (
        manifest?.format !== 'studio-arsitektur-floor-manifest' ||
        manifest.version !== 1 ||
        manifest.units !== 'm' ||
        !Array.isArray(floors) ||
        floors.length < 1 ||
        floors.length > 12 ||
        typeof manifest.northDegrees !== 'number' ||
        !Number.isFinite(manifest.northDegrees) ||
        floors.some(floor =>
          typeof floor?.name !== 'string' ||
          typeof floor.elevation !== 'number' ||
          !Number.isFinite(floor.elevation) ||
          typeof floor.baseElevation !== 'number' ||
          !Number.isFinite(floor.baseElevation) ||
          typeof floor.elevationRatio !== 'number' ||
          !Number.isFinite(floor.elevationRatio) ||
          floor.elevationRatio <= 0 ||
          floor.elevationRatio >= 1 ||
          typeof floor.baseElevationRatio !== 'number' ||
          !Number.isFinite(floor.baseElevationRatio) ||
          floor.baseElevationRatio < 0 ||
          floor.baseElevationRatio >= 1)
      ) {
        throw new Error('Struktur atau versi manifest lantai tidak didukung.');
      }
      floorCountInput.value = String(floors.length);
      northInput.value = String(manifest.northDegrees);
      floorCountInput.readOnly = true;
      northInput.readOnly = true;
      showStatus(uploadStatus, `${floors.length} lantai terbaca. Arah utara dari manifest dapat dikoreksi setelah impor.`, false);
    } catch (error) {
      floorCountInput.readOnly = false;
      northInput.readOnly = false;
      showStatus(uploadStatus, `Manifest lantai tidak valid: ${error.message}`, true);
    }
  });

  uploadForm.addEventListener('submit', async event => {
    event.preventDefault();
    uploadButton.disabled = true;
    showStatus(uploadStatus, 'Menganalisis model, membuat pratinjau dan denah…', false);
    try {
      const uploadData = new FormData(uploadForm);
      uploadData.set('isPublic', uploadForm.elements.isPublic.checked ? 'true' : 'false');
      const result = await api('/api/admin/projects', {
        method: 'POST',
        body: uploadData
      });
      const floorSource = result.project.metadata.floorSource === 'sketchup-manifest'
        ? 'elevasi grup SketchUp'
        : 'perkiraan otomatis';
      showStatus(uploadStatus,
        `Impor selesai. Ukuran terukur ${result.project.metadata.dimensions.width.toFixed(2)} × ` +
        `${result.project.metadata.dimensions.depth.toFixed(2)} × ${result.project.metadata.dimensions.height.toFixed(2)} m; ` +
        `${result.project.metadata.floorCount} denah dibuat dari ${floorSource}. Periksa sebelum membagikan.`,
        false);
      uploadForm.reset();
      uploadForm.elements.floorCount.readOnly = false;
      uploadForm.elements.northDegrees.readOnly = false;
      uploadForm.elements.year.value = new Date().getFullYear();
      uploadForm.elements.northDegrees.value = '0';
      await loadProjects();
    } catch (error) {
      showStatus(uploadStatus, error.message, true);
    } finally {
      uploadButton.disabled = false;
    }
  });

  checkSession();
})();
