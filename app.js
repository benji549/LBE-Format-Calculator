import { APP_CONFIG, isConfigured } from './config.js';
import {
  calculate,
  cloneAsNew,
  createDefaultFormat,
  createExpense,
  formatMoney,
  formatNumber,
  normalizeFormat,
} from './calculator.js';
import {
  supabase,
  createFormat,
  deleteFormat,
  getProfile,
  getSession,
  listFormats,
  listVersions,
  signInWithPassword,
  signUpWithPassword,
  signOut,
  subscribeToFormats,
  updateFormat,
  updateProfile,
} from './db.js';

const state = {
  session: null,
  profile: null,
  formats: [],
  currentRecord: null,
  draft: null,
  dirty: false,
  compareIds: new Set(),
  realtimeChannel: null,
  realtimeTimer: null,
};

const fieldDefinitions = {
  area: ['Area', 'm²', 'Total usable or leased floor area.'],
  thrc: ['THRC', 'guests/hour', 'Theoretical hourly ride capacity.'],
  ticketPrice: ['Ticket price', 'per guest', 'Average realized ticket price before tax.'],
  operatingHours: ['Operating hours', 'hours/day', 'Average daily open hours.'],
  daysPerWeek: ['Operating days', 'days/week', 'Annual calculations multiply this value by 52.'],
  utilization: ['Utilization', '%', 'Share of theoretical capacity actually sold.'],
  rentAmount: ['Rent', '', 'Enter either total rent or rent per square metre.'],
  headsetCount: ['Headsets', 'units', 'Number of headsets purchased in Year 1.'],
  headsetPrice: ['Price per headset', 'each', 'Hardware purchase price per headset.'],
  startupOther: ['Other startup costs', 'one-time', 'Design, build, licensing, fit-out, installation, launch, or other upfront costs.'],
  year2RevenueGrowth: ['Year 2 revenue growth', '%', 'Change in ticket revenue from Year 1 to Year 2.'],
  year2ExpenseInflation: ['Year 2 recurring-cost change', '%', 'Applied to rent and all recurring expense lines in Year 2.'],
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = message;
  $('#toastRegion').append(el);
  window.setTimeout(() => el.remove(), 4200);
}

function setSyncStatus(message) {
  $('#syncStatus').textContent = message;
}

function showOnly(screenId) {
  for (const id of ['setupScreen', 'authScreen', 'appShell']) {
    $(`#${id}`).classList.toggle('hidden', id !== screenId);
  }
}

function ownerName(record) {
  return record?.owner?.display_name || record?.owner?.email || 'Unknown teammate';
}

function isOwner(record = state.currentRecord) {
  return Boolean(record && state.session && record.owner_id === state.session.user.id);
}

function canEdit() {
  // Every signed-in teammate can edit every format in the communal library.
  return Boolean(state.session);
}

function markDirty() {
  if (!canEdit()) return;
  state.dirty = true;
  updateEditorToolbar();
}

function clearDirty() {
  state.dirty = false;
  updateEditorToolbar();
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value));
}

async function initialize() {
  if (!isConfigured()) {
    showOnly('setupScreen');
    return;
  }

  try {
    state.session = await getSession();
    if (state.session) await enterApp();
    else showOnly('authScreen');
  } catch (error) {
    showOnly('authScreen');
    toast(error.message || 'Could not initialize Supabase.', 'error');
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    state.session = session;
    if (session && event !== 'SIGNED_OUT') await enterApp();
    else if (!session) leaveApp();
  });
}

async function enterApp() {
  showOnly('appShell');
  try {
    state.profile = await getProfile(state.session.user.id);
    renderProfileButton();
    await refreshFormats({ preserveDraft: true });
    startRealtime();
  } catch (error) {
    toast(error.message || 'Could not load team data.', 'error');
  }
}

function leaveApp() {
  if (state.realtimeChannel) supabase.removeChannel(state.realtimeChannel);
  state.session = null;
  state.profile = null;
  state.formats = [];
  state.currentRecord = null;
  state.draft = null;
  state.compareIds.clear();
  showOnly('authScreen');
}

function startRealtime() {
  if (state.realtimeChannel) supabase.removeChannel(state.realtimeChannel);
  state.realtimeChannel = subscribeToFormats(() => {
    window.clearTimeout(state.realtimeTimer);
    state.realtimeTimer = window.setTimeout(async () => {
      setSyncStatus('Refreshing team changes…');
      await refreshFormats({ preserveDraft: true, fromRealtime: true });
      setSyncStatus('Cloud connected');
    }, 350);
  });
}

async function refreshFormats({ preserveDraft = true, fromRealtime = false } = {}) {
  const previous = state.currentRecord;
  const formats = await listFormats();
  state.formats = formats;

  for (const id of [...state.compareIds]) {
    if (!formats.some((record) => record.id === id)) state.compareIds.delete(id);
  }

  if (previous) {
    const latest = formats.find((record) => record.id === previous.id);
    if (!latest) {
      state.currentRecord = null;
      state.draft = null;
      state.dirty = false;
    } else if (latest.version_number !== previous.version_number) {
      if (preserveDraft && state.dirty) {
        state.currentRecord = { ...previous, remote_version_number: latest.version_number };
        if (fromRealtime) toast('Another teammate saved a newer version. Your draft was preserved.', 'error');
      } else {
        state.currentRecord = latest;
        state.draft = normalizeFormat(latest.format_data);
        state.dirty = false;
      }
    } else {
      state.currentRecord = latest;
    }
  }

  renderLibrary();
  renderCompareControls();
  renderEditor();
}

function renderProfileButton() {
  const label = state.profile?.display_name || state.profile?.email || state.session?.user?.email || 'Profile';
  $('#profileButton').textContent = label;
}

function renderLibrary() {
  const query = $('#searchInput').value.trim().toLowerCase();
  const filter = $('#libraryFilter').value;
  const userId = state.session?.user?.id;

  const visible = state.formats.filter((record) => {
    const matchesSearch = !query || [record.name, record.description, ownerName(record)]
      .join(' ')
      .toLowerCase()
      .includes(query);
    const matchesFilter = filter === 'all'
      || (filter === 'mine' && record.owner_id === userId)
      || (filter === 'team' && record.owner_id !== userId);
    return matchesSearch && matchesFilter;
  });

  $('#formatList').innerHTML = visible.length
    ? visible.map(formatCardHtml).join('')
    : '<div class="empty-list">No matching formats.</div>';
}

function formatCardHtml(record) {
  const c = calculate(record.format_data);
  const selected = state.compareIds.has(record.id);
  const active = state.currentRecord?.id === record.id;
  return `
    <article class="format-card ${active ? 'active' : ''}" data-format-card="${record.id}">
      <div class="format-card-head">
        <input type="checkbox" data-action="toggle-compare" data-format-id="${record.id}" ${selected ? 'checked' : ''} aria-label="Select ${escapeHtml(record.name)} for comparison">
        <div class="format-card-title">
          <h3 title="${escapeHtml(record.name)}">${escapeHtml(record.name)}</h3>
          <p>${escapeHtml(ownerName(record))} · v${record.version_number} · communal</p>
        </div>
      </div>
      <div class="format-card-metrics">
        <div class="mini-metric"><span>Area</span><strong>${formatNumber(c.area)} m²</strong></div>
        <div class="mini-metric"><span>THRC</span><strong>${formatNumber(record.format_data.thrc?.value)}</strong></div>
        <div class="mini-metric"><span>Year 2 profit</span><strong class="${c.profit2 >= 0 ? 'positive' : 'negative'}">${formatMoney(c.profit2, record.currency)}</strong></div>
      </div>
      <div class="format-card-actions">
        <button class="btn small" data-action="open-format" data-format-id="${record.id}" type="button">Open</button>
        <button class="btn small" data-action="duplicate-record" data-format-id="${record.id}" type="button">Duplicate</button>
      </div>
    </article>`;
}

function renderCompareControls() {
  const count = state.compareIds.size;
  $('#compareCount').textContent = String(count);
  $('#openComparisonButton').disabled = count < 2;
}

function openRecord(record) {
  state.currentRecord = record;
  state.draft = normalizeFormat(record.format_data);
  state.draft.visibility = 'team';
  state.dirty = false;
  renderLibrary();
  renderEditor();
}

function newFormat() {
  state.currentRecord = null;
  state.draft = createDefaultFormat(state.formats.length + 1);
  state.draft.visibility = 'team';
  state.dirty = true;
  renderLibrary();
  renderEditor();
}

function updateEditorToolbar() {
  if (!state.draft) return;
  const owner = state.currentRecord ? ownerName(state.currentRecord) : (state.profile?.display_name || state.profile?.email);
  $('#editorOwner').textContent = state.currentRecord
    ? `Communal format · created by ${owner}`
    : 'New communal format · not saved yet';
  $('#editorTitle').textContent = state.draft.name || 'Untitled format';

  const meta = state.currentRecord
    ? `Version ${state.currentRecord.version_number}${state.currentRecord.remote_version_number ? ` · newer cloud version ${state.currentRecord.remote_version_number}` : ''} · updated ${formatDate(state.currentRecord.updated_at)}${state.dirty ? ' · unsaved changes' : ''}`
    : 'Unsaved draft';
  $('#editorMetadata').textContent = meta;

  $('#saveButton').classList.toggle('hidden', !canEdit());
  $('#deleteButton').classList.toggle('hidden', !state.currentRecord);
  $('#historyButton').disabled = !state.currentRecord;
  $('#saveButton').textContent = state.currentRecord ? 'Save new version' : 'Publish to cloud';
  $('#saveButton').disabled = !state.dirty && Boolean(state.currentRecord);
}

function renderEditor() {
  const hasDraft = Boolean(state.draft);
  $('#emptyEditor').classList.toggle('hidden', hasDraft);
  $('#editorContent').classList.toggle('hidden', !hasDraft);
  if (!hasDraft) return;
  updateEditorToolbar();
  renderForm();
  renderResults();
}

function disabledAttr() {
  return canEdit() ? '' : 'disabled';
}

function fieldHtml(key, extraClass = '') {
  const s = state.draft;
  const item = s[key];
  const [label, unit, help] = fieldDefinitions[key];
  const displayUnit = key === 'rentAmount'
    ? (s.rentMode === 'perM2'
        ? `per m² / ${s.rentBilling === 'monthly' ? 'month' : 'year'}`
        : `total / ${s.rentBilling === 'monthly' ? 'month' : 'year'}`)
    : unit;

  return `
    <div class="field-card ${extraClass}">
      <label title="${escapeHtml(help)}">${escapeHtml(label)}</label>
      <div class="input-row">
        <div class="input-with-unit">
          <input type="number" data-field="${key}" data-role="value" value="${item.value}" step="${item.step}" ${disabledAttr()}>
          <span class="unit">${escapeHtml(displayUnit)}</span>
        </div>
        <label class="slider-toggle">
          <input type="checkbox" data-action="toggle-slider" data-field="${key}" ${item.useSlider ? 'checked' : ''} ${disabledAttr()}>
          Range
        </label>
      </div>
      ${item.useSlider ? `
        <div class="range-box">
          <div class="range-values">
            <div><div class="mini-label">Minimum</div><input type="number" data-field="${key}" data-role="min" value="${item.min}" step="${item.step}" ${disabledAttr()}></div>
            <div><div class="mini-label">Maximum</div><input type="number" data-field="${key}" data-role="max" value="${item.max}" step="${item.step}" ${disabledAttr()}></div>
          </div>
          <input type="range" data-field="${key}" data-role="value" min="${item.min}" max="${item.max}" step="${item.step}" value="${item.value}" ${disabledAttr()}>
        </div>` : ''}
      ${key === 'rentAmount' ? `
        <div class="rent-options">
          <select data-prop="rentMode" ${disabledAttr()}>
            <option value="perM2" ${s.rentMode === 'perM2' ? 'selected' : ''}>Rent per m²</option>
            <option value="total" ${s.rentMode === 'total' ? 'selected' : ''}>Total rent</option>
          </select>
          <select data-prop="rentBilling" ${disabledAttr()}>
            <option value="monthly" ${s.rentBilling === 'monthly' ? 'selected' : ''}>Monthly</option>
            <option value="annual" ${s.rentBilling === 'annual' ? 'selected' : ''}>Annual</option>
          </select>
        </div>` : ''}
    </div>`;
}

function expenseHtml(expense) {
  const amount = expense.amount;
  return `
    <div class="expense-row">
      <div class="expense-main">
        <div class="expense-name"><div class="mini-label">Expense name</div><input type="text" data-expense-id="${expense.id}" data-expense-prop="name" value="${escapeHtml(expense.name)}" ${disabledAttr()}></div>
        <div><div class="mini-label">Amount</div><input type="number" data-expense-id="${expense.id}" data-expense-prop="value" value="${amount.value}" step="${amount.step}" ${disabledAttr()}></div>
        <label class="checkbox-box"><input type="checkbox" data-expense-id="${expense.id}" data-expense-prop="recurring" ${expense.recurring ? 'checked' : ''} ${disabledAttr()}>Recurring</label>
        <div><div class="mini-label">Frequency</div><select data-expense-id="${expense.id}" data-expense-prop="cadence" ${expense.recurring && canEdit() ? '' : 'disabled'}><option value="monthly" ${expense.cadence === 'monthly' ? 'selected' : ''}>Monthly</option><option value="annual" ${expense.cadence === 'annual' ? 'selected' : ''}>Annual</option></select></div>
        <button class="btn small danger" data-action="delete-expense" data-expense-id="${expense.id}" type="button" ${disabledAttr()}>Remove</button>
      </div>
      <div class="expense-slider">
        <label class="slider-toggle"><input type="checkbox" data-expense-id="${expense.id}" data-expense-prop="useSlider" ${amount.useSlider ? 'checked' : ''} ${disabledAttr()}>Use uncertainty range</label>
        ${amount.useSlider ? `
          <div class="range-box">
            <div class="range-values">
              <div><div class="mini-label">Minimum</div><input type="number" data-expense-id="${expense.id}" data-expense-prop="min" value="${amount.min}" step="${amount.step}" ${disabledAttr()}></div>
              <div><div class="mini-label">Maximum</div><input type="number" data-expense-id="${expense.id}" data-expense-prop="max" value="${amount.max}" step="${amount.step}" ${disabledAttr()}></div>
            </div>
            <input type="range" data-expense-id="${expense.id}" data-expense-prop="value" min="${amount.min}" max="${amount.max}" step="${amount.step}" value="${amount.value}" ${disabledAttr()}>
          </div>` : ''}
      </div>
    </div>`;
}

function renderForm() {
  const s = state.draft;
  $('#formRoot').innerHTML = `
    <div class="section">
      <div class="scenario-meta">
        <div class="simple-field"><label>Format name</label><input type="text" data-prop="name" value="${escapeHtml(s.name)}" ${disabledAttr()}></div>
        <div class="simple-field"><label>Currency</label><select data-prop="currency" ${disabledAttr()}>${['USD','CAD','EUR','GBP','AUD'].map((currency) => `<option value="${currency}" ${s.currency === currency ? 'selected' : ''}>${currency}</option>`).join('')}</select></div>
        <div class="simple-field"><label>Access</label><input type="text" value="Communal" disabled></div>
        <div class="simple-field description-field"><label>Description</label><textarea data-prop="description" rows="2" ${disabledAttr()} placeholder="What type of experience is this?">${escapeHtml(s.description)}</textarea></div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><div><h3 class="section-title">Capacity and revenue</h3><p class="section-note">Utilization accounts for demand, downtime, imperfect loading, seasonality, and unsold capacity.</p></div></div>
      <div class="field-grid">${fieldHtml('area')}${fieldHtml('thrc')}${fieldHtml('ticketPrice')}${fieldHtml('utilization')}${fieldHtml('operatingHours')}${fieldHtml('daysPerWeek')}</div>
    </div>

    <div class="section">
      <div class="section-head"><div><h3 class="section-title">Rent and startup investment</h3><p class="section-note">Headsets and other startup costs are treated as Year 1 one-time expenses.</p></div></div>
      <div class="field-grid">${fieldHtml('rentAmount', 'wide')}${fieldHtml('headsetCount')}${fieldHtml('headsetPrice')}${fieldHtml('startupOther', 'wide')}</div>
    </div>

    <div class="section">
      <div class="section-head">
        <div><h3 class="section-title">Other expenses</h3><p class="section-note">Non-recurring lines are charged only in Year 1. Recurring lines continue into Year 2.</p></div>
        ${canEdit() ? '<button class="btn small primary" data-action="add-expense" type="button">+ Add expense</button>' : ''}
      </div>
      <div class="expense-list">${s.expenses.length ? s.expenses.map(expenseHtml).join('') : '<div class="empty-list">No additional expenses.</div>'}</div>
    </div>

    <div class="section">
      <div class="section-head"><div><h3 class="section-title">Year 2 assumptions</h3><p class="section-note">Use negative values for contraction or cost reductions.</p></div></div>
      <div class="field-grid">${fieldHtml('year2RevenueGrowth')}${fieldHtml('year2ExpenseInflation')}</div>
    </div>`;
}

function metricRow(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderResults() {
  const s = state.draft;
  const c = calculate(s);
  const warnings = [];
  if (Number(s.utilization.value) > 100) warnings.push('Utilization exceeds 100% of theoretical capacity.');
  if (c.area <= 0) warnings.push('Area must be above zero for per-m² metrics.');
  if (c.breakEvenUtilization1 > 100) warnings.push(`Year 1 break-even requires ${formatNumber(c.breakEvenUtilization1, 1)}% utilization.`);
  if (Number(s.ticketPrice.value) <= 0) warnings.push('Ticket price must be above zero.');

  $('#resultsRoot').innerHTML = `
    <div class="results-heading"><div><h3>Calculated performance</h3><p class="section-note">Pre-tax operating estimate before financing, depreciation, and revenue sharing unless entered as expenses.</p></div></div>
    <div class="summary-strip">
      <div class="summary-chip"><div class="k">Annual capacity</div><div class="v">${formatNumber(c.annualCapacity)}</div></div>
      <div class="summary-chip"><div class="k">Expected visits</div><div class="v">${formatNumber(c.attendance1)}</div></div>
      <div class="summary-chip"><div class="k">Revenue / m²</div><div class="v">${formatMoney(c.revenuePerM2, s.currency)}</div></div>
    </div>
    <div class="year-grid">
      <div class="year-card">
        <h3>Year 1</h3>
        <div class="metric-list">
          ${metricRow('Ticket revenue', formatMoney(c.revenue1, s.currency))}
          ${metricRow('Annual rent', formatMoney(c.rent1, s.currency))}
          ${metricRow('Headset purchase', formatMoney(c.headsetCapex, s.currency))}
          ${metricRow('Other startup', formatMoney(c.startup, s.currency))}
          ${metricRow('Other expenses', formatMoney(c.otherYear1, s.currency))}
          ${metricRow('Total expenses', formatMoney(c.expenses1, s.currency))}
          ${metricRow('Profit margin', `${formatNumber(c.margin1, 1)}%`)}
          ${metricRow('Break-even utilization', `${formatNumber(c.breakEvenUtilization1, 1)}%`)}
        </div>
        <div class="profit"><div class="label">Estimated profit</div><div class="value ${c.profit1 >= 0 ? 'positive' : 'negative'}">${formatMoney(c.profit1, s.currency)}</div><div class="${c.profitPerM21 >= 0 ? 'positive' : 'negative'}">${formatMoney(c.profitPerM21, s.currency)} per m²</div></div>
      </div>
      <div class="year-card">
        <h3>Year 2</h3>
        <div class="metric-list">
          ${metricRow('Ticket revenue', formatMoney(c.revenue2, s.currency))}
          ${metricRow('Annual rent', formatMoney(c.rent2, s.currency))}
          ${metricRow('Recurring expenses', formatMoney(c.expenses2 - c.rent2, s.currency))}
          ${metricRow('Total expenses', formatMoney(c.expenses2, s.currency))}
          ${metricRow('Profit margin', `${formatNumber(c.margin2, 1)}%`)}
        </div>
        <div class="profit"><div class="label">Estimated profit</div><div class="value ${c.profit2 >= 0 ? 'positive' : 'negative'}">${formatMoney(c.profit2, s.currency)}</div><div class="${c.profitPerM22 >= 0 ? 'positive' : 'negative'}">${formatMoney(c.profitPerM22, s.currency)} per m²</div></div>
      </div>
    </div>
    ${warnings.length ? `<div class="warning">${warnings.map(escapeHtml).join('<br>')}</div>` : ''}`;
}

function clampNumberObject(obj) {
  if (obj.min > obj.max) [obj.min, obj.max] = [obj.max, obj.min];
  obj.value = Math.min(obj.max, Math.max(obj.min, obj.value));
}

async function saveCurrent() {
  if (!canEdit() || !state.draft) return;
  if (!state.draft.name.trim()) {
    toast('Give the format a name before saving.', 'error');
    return;
  }

  if (!state.currentRecord) {
    try {
      setSyncStatus('Publishing…');
      const created = await createFormat(state.draft);
      state.currentRecord = created;
      state.draft = normalizeFormat(created.format_data);
      clearDirty();
      await refreshFormats({ preserveDraft: false });
      toast('Format published to the team library.', 'success');
    } catch (error) {
      toast(error.message || 'Could not publish the format.', 'error');
    } finally {
      setSyncStatus('Cloud connected');
    }
    return;
  }

  $('#changeNote').value = '';
  $('#saveDialog').showModal();
}

async function confirmVersionSave() {
  try {
    setSyncStatus('Saving version…');
    const updated = await updateFormat(state.currentRecord, state.draft, $('#changeNote').value);
    state.currentRecord = {
      ...state.currentRecord,
      ...updated,
      owner: state.currentRecord.owner,
      remote_version_number: undefined,
    };
    state.draft = normalizeFormat(updated.format_data);
    clearDirty();
    await refreshFormats({ preserveDraft: false });
    toast(`Saved version ${updated.version_number}.`, 'success');
  } catch (error) {
    const message = error.message || 'Could not save the format.';
    if (message.includes('VERSION_CONFLICT')) {
      $('#saveDialog').close();
      const saveCopy = window.confirm('A newer version was saved while you were editing. Press OK to save your draft as a new copy, or Cancel to keep the unsaved draft and review the latest version.');
      await refreshFormats({ preserveDraft: true });
      if (saveCopy) {
        try {
          const copy = cloneAsNew(state.draft);
          const created = await createFormat(copy);
          state.currentRecord = created;
          state.draft = normalizeFormat(created.format_data);
          clearDirty();
          await refreshFormats({ preserveDraft: false });
          toast('Your conflicting draft was saved as a new format.', 'success');
        } catch (copyError) {
          toast(copyError.message || 'Could not save the copy.', 'error');
        }
      }
    } else {
      toast(message, 'error');
    }
  } finally {
    setSyncStatus('Cloud connected');
  }
}

async function duplicateRecord(record) {
  try {
    const copy = cloneAsNew(record.format_data);

    // Every duplicate is part of the same communal library.
    copy.visibility = 'team';

    const created = await createFormat(copy);
    await refreshFormats({ preserveDraft: true });
    openRecord(state.formats.find((item) => item.id === created.id) || created);

    toast('A communal editable copy was created.', 'success');
  } catch (error) {
    toast(error.message || 'Could not duplicate this format.', 'error');
  }
}

async function removeCurrent() {
  if (!state.session || !state.currentRecord) return;
  if (!window.confirm(`Delete “${state.currentRecord.name}” and all of its version history for everyone?`)) return;
  try {
    await deleteFormat(state.currentRecord.id);
    state.currentRecord = null;
    state.draft = null;
    state.dirty = false;
    await refreshFormats({ preserveDraft: false });
    toast('Format deleted.', 'success');
  } catch (error) {
    toast(error.message || 'Could not delete the format.', 'error');
  }
}

async function showHistory() {
  if (!state.currentRecord) return;
  $('#historySubtitle').textContent = state.currentRecord.name;
  $('#historyList').innerHTML = '<div class="empty-list">Loading versions…</div>';
  $('#historyDialog').showModal();
  try {
    const versions = await listVersions(state.currentRecord.id);
    $('#historyList').innerHTML = versions.length
      ? versions.map((version) => `
          <div class="history-item">
            <div>
              <h3>Version ${version.version_number} · ${escapeHtml(version.change_note || 'No change note')}</h3>
              <p>${escapeHtml(version.author?.display_name || version.author?.email || 'Unknown')} · ${formatDate(version.created_at)}</p>
            </div>
            ${isOwner() ? `<button class="btn small" data-action="use-version" data-version-id="${version.id}" type="button">Use as draft</button>` : ''}
          </div>`).join('')
      : '<div class="empty-list">No versions found.</div>';
    $('#historyList').dataset.versions = JSON.stringify(versions);
  } catch (error) {
    $('#historyList').innerHTML = `<div class="empty-list">${escapeHtml(error.message)}</div>`;
  }
}

function useVersionAsDraft(versionId) {
  const versions = JSON.parse($('#historyList').dataset.versions || '[]');
  const version = versions.find((item) => item.id === versionId);
  if (!version) return;
  state.draft = normalizeFormat(version.format_data);
  state.draft.name = state.currentRecord.name;
  state.dirty = true;
  $('#historyDialog').close();
  renderEditor();
  toast(`Version ${version.version_number} loaded as an unsaved draft. Save it to create a new version.`, 'success');
}

function showComparison() {
  const selected = state.formats.filter((record) => state.compareIds.has(record.id));
  if (selected.length < 2) return;
  $('#comparisonRoot').innerHTML = `
    <table>
      <thead><tr><th>Metric</th>${selected.map((record) => `<th>${escapeHtml(record.name)}<br><span class="unit">${escapeHtml(ownerName(record))} · ${record.currency}</span></th>`).join('')}</tr></thead>
      <tbody>
        ${comparisonRow('Area', selected, (r, c) => `${formatNumber(c.area)} m²`)}
        ${comparisonRow('THRC', selected, (r) => formatNumber(r.format_data.thrc?.value))}
        ${comparisonRow('Utilization', selected, (r) => `${formatNumber(r.format_data.utilization?.value, 1)}%`)}
        ${comparisonRow('Expected visits', selected, (r, c) => formatNumber(c.attendance1))}
        ${comparisonRow('Year 1 revenue', selected, (r, c) => formatMoney(c.revenue1, r.currency))}
        ${comparisonRow('Year 1 expenses', selected, (r, c) => formatMoney(c.expenses1, r.currency))}
        ${comparisonRow('Year 1 profit', selected, (r, c) => `<span class="${c.profit1 >= 0 ? 'positive' : 'negative'}">${formatMoney(c.profit1, r.currency)}</span>`, true)}
        ${comparisonRow('Year 1 profit / m²', selected, (r, c) => `<span class="${c.profitPerM21 >= 0 ? 'positive' : 'negative'}">${formatMoney(c.profitPerM21, r.currency)}</span>`, true)}
        ${comparisonRow('Year 2 revenue', selected, (r, c) => formatMoney(c.revenue2, r.currency))}
        ${comparisonRow('Year 2 expenses', selected, (r, c) => formatMoney(c.expenses2, r.currency))}
        ${comparisonRow('Year 2 profit', selected, (r, c) => `<span class="${c.profit2 >= 0 ? 'positive' : 'negative'}">${formatMoney(c.profit2, r.currency)}</span>`, true)}
        ${comparisonRow('Year 2 profit / m²', selected, (r, c) => `<span class="${c.profitPerM22 >= 0 ? 'positive' : 'negative'}">${formatMoney(c.profitPerM22, r.currency)}</span>`, true)}
      </tbody>
    </table>`;
  $('#comparisonDialog').showModal();
}

function comparisonRow(label, records, formatter, allowHtml = false) {
  return `<tr><td><strong>${escapeHtml(label)}</strong></td>${records.map((record) => {
    const value = formatter(record, calculate(record.format_data));
    return `<td>${allowHtml ? value : escapeHtml(value)}</td>`;
  }).join('')}</tr>`;
}

function handleFieldInput(target) {
  if (!canEdit()) return;
  const key = target.dataset.field;
  const role = target.dataset.role;
  const object = state.draft[key];
  object[role] = Number(target.value);
  if (role === 'min' || role === 'max') {
    clampNumberObject(object);
    renderForm();
  } else {
    document.querySelectorAll(`[data-field="${key}"][data-role="value"]`).forEach((el) => {
      if (el !== target) el.value = object.value;
    });
  }
  markDirty();
  renderResults();
}

function handleExpenseInput(target) {
  if (!canEdit()) return;
  const expense = state.draft.expenses.find((item) => item.id === target.dataset.expenseId);
  if (!expense) return;
  const prop = target.dataset.expenseProp;

  if (prop === 'name' || prop === 'cadence') expense[prop] = target.value;
  else if (prop === 'recurring') {
    expense.recurring = target.checked;
    renderForm();
  } else if (prop === 'useSlider') {
    expense.amount.useSlider = target.checked;
    renderForm();
  } else {
    expense.amount[prop] = Number(target.value);
    if (prop === 'min' || prop === 'max') {
      clampNumberObject(expense.amount);
      renderForm();
    } else {
      document.querySelectorAll(`[data-expense-id="${expense.id}"][data-expense-prop="value"]`).forEach((el) => {
        if (el !== target) el.value = expense.amount.value;
      });
    }
  }

  markDirty();
  renderResults();
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  $('#loginStatus').textContent = 'Signing in…';
  try {
    await signInWithPassword(email, password);
    $('#loginStatus').textContent = '';
  } catch (error) {
    $('#loginStatus').textContent = error.message || 'Could not sign in.';
  }
});

$('#createAccountButton').addEventListener('click', async () => {
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;

  if (!email) {
    $('#loginStatus').textContent = 'Enter an email address first.';
    return;
  }
  if (password.length < 6) {
    $('#loginStatus').textContent = 'Use a password with at least 6 characters.';
    return;
  }

  $('#loginStatus').textContent = 'Creating account…';
  try {
    const data = await signUpWithPassword(email, password);
    if (data.session) {
      $('#loginStatus').textContent = '';
    } else {
      $('#loginStatus').textContent = 'Account created. Supabase is still requiring email confirmation; disable Confirm email in the Email provider settings.';
    }
  } catch (error) {
    $('#loginStatus').textContent = error.message || 'Could not create the account.';
  }
});

$('#signOutButton').addEventListener('click', () => signOut().catch((error) => toast(error.message, 'error')));
$('#newFormatButton').addEventListener('click', newFormat);
$('#saveButton').addEventListener('click', saveCurrent);
$('#deleteButton').addEventListener('click', removeCurrent);
$('#historyButton').addEventListener('click', showHistory);
$('#duplicateButton').addEventListener('click', () => {
  if (state.currentRecord) duplicateRecord(state.currentRecord);
  else {
    state.draft = cloneAsNew(state.draft);
    markDirty();
    renderEditor();
  }
});
$('#openComparisonButton').addEventListener('click', showComparison);
$('#clearComparisonButton').addEventListener('click', () => {
  state.compareIds.clear();
  renderLibrary();
  renderCompareControls();
});
$('#searchInput').addEventListener('input', renderLibrary);
$('#libraryFilter').addEventListener('change', renderLibrary);

$('#saveDialogForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await confirmVersionSave();
  if ($('#saveDialog').open) $('#saveDialog').close();
});

$('#profileButton').addEventListener('click', () => {
  $('#displayName').value = state.profile?.display_name || '';
  $('#profileDialog').showModal();
});

$('#profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    state.profile = await updateProfile($('#displayName').value);
    renderProfileButton();
    $('#profileDialog').close();
    await refreshFormats({ preserveDraft: true });
    toast('Profile updated.', 'success');
  } catch (error) {
    toast(error.message || 'Could not update the profile.', 'error');
  }
});

document.addEventListener('click', async (event) => {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) {
    const action = actionTarget.dataset.action;
    const formatId = actionTarget.dataset.formatId;
    const record = state.formats.find((item) => item.id === formatId);

    if (action === 'open-format' && record) openRecord(record);
    if (action === 'duplicate-record' && record) await duplicateRecord(record);
    if (action === 'toggle-compare') {
      event.stopPropagation();
      if (actionTarget.checked) {
        if (state.compareIds.size >= APP_CONFIG.maxComparedFormats) {
          actionTarget.checked = false;
          toast(`Compare up to ${APP_CONFIG.maxComparedFormats} formats at once.`, 'error');
        } else state.compareIds.add(formatId);
      } else state.compareIds.delete(formatId);
      renderCompareControls();
    }
    if (action === 'add-expense') {
      state.draft.expenses.push(createExpense());
      markDirty();
      renderForm();
      renderResults();
    }
    if (action === 'delete-expense') {
      state.draft.expenses = state.draft.expenses.filter((item) => item.id !== actionTarget.dataset.expenseId);
      markDirty();
      renderForm();
      renderResults();
    }
    if (action === 'toggle-slider') {
      const key = actionTarget.dataset.field;
      state.draft[key].useSlider = actionTarget.checked;
      markDirty();
      renderForm();
      renderResults();
    }
    if (action === 'use-version') useVersionAsDraft(actionTarget.dataset.versionId);
  }

  const closeButton = event.target.closest('[data-close-dialog]');
  if (closeButton) $(`#${closeButton.dataset.closeDialog}`).close();
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (!state.draft) return;

  if (target.dataset.prop) {
    state.draft[target.dataset.prop] = target.value;
    markDirty();
    if (target.dataset.prop === 'name') updateEditorToolbar();
    if (['currency', 'rentMode', 'rentBilling'].includes(target.dataset.prop)) renderForm();
    renderResults();
    return;
  }
  if (target.dataset.field && target.dataset.role) {
    handleFieldInput(target);
    return;
  }
  if (target.dataset.expenseId && target.dataset.expenseProp) handleExpenseInput(target);
});

window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

initialize();
