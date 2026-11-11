/**
 * @fileoverview Code tables for the coded `drug/event` fields openFDA returns as
 * bare strings — route of administration, reaction outcome, age group, onset-age
 * unit, the per-drug action, dechallenge, rechallenge, duration, interval, and
 * dose-unit codes, and the report-level type, reporter, sender, receiver, and
 * expedited codes. One source for both the code meanings
 * `openfda_search_adverse_events` renders in `content[]` and the field catalog
 * notes `openfda_describe_fields` serves.
 *
 * Labels are transcribed from FDA's drug/event field reference
 * (https://open.fda.gov/fields/drugevent.yaml), lower-cased, with two of its
 * misspellings corrected: `049` "Oropharingeal" → oropharyngeal and `057`
 * "Sunconjunctival" → subconjunctival. Each table holds exactly the codes that
 * reference labels for its field, so a code it leaves out — or labels twice —
 * renders raw.
 * @module mcp-server/tools/drug-event-codes
 */

/** `patient.drug.drugadministrationroute` — every code openFDA indexes is a 3-character string. */
export const ADMINISTRATION_ROUTES: ReadonlyMap<string, string> = new Map([
  ['001', 'auricular (otic)'],
  ['002', 'buccal'],
  ['003', 'cutaneous'],
  ['004', 'dental'],
  ['005', 'endocervical'],
  ['006', 'endosinusial'],
  ['007', 'endotracheal'],
  ['008', 'epidural'],
  ['009', 'extra-amniotic'],
  ['010', 'hemodialysis'],
  ['011', 'intra corpus cavernosum'],
  ['012', 'intra-amniotic'],
  ['013', 'intra-arterial'],
  ['014', 'intra-articular'],
  ['015', 'intra-uterine'],
  ['016', 'intracardiac'],
  ['017', 'intracavernous'],
  ['018', 'intracerebral'],
  ['019', 'intracervical'],
  ['020', 'intracisternal'],
  ['021', 'intracorneal'],
  ['022', 'intracoronary'],
  ['023', 'intradermal'],
  ['024', 'intradiscal (intraspinal)'],
  ['025', 'intrahepatic'],
  ['026', 'intralesional'],
  ['027', 'intralymphatic'],
  ['028', 'intramedullar (bone marrow)'],
  ['029', 'intrameningeal'],
  ['030', 'intramuscular'],
  ['031', 'intraocular'],
  ['032', 'intrapericardial'],
  ['033', 'intraperitoneal'],
  ['034', 'intrapleural'],
  ['035', 'intrasynovial'],
  ['036', 'intratumor'],
  ['037', 'intrathecal'],
  ['038', 'intrathoracic'],
  ['039', 'intratracheal'],
  ['040', 'intravenous bolus'],
  ['041', 'intravenous drip'],
  ['042', 'intravenous (not otherwise specified)'],
  ['043', 'intravesical'],
  ['044', 'iontophoresis'],
  ['045', 'nasal'],
  ['046', 'occlusive dressing technique'],
  ['047', 'ophthalmic'],
  ['048', 'oral'],
  ['049', 'oropharyngeal'],
  ['050', 'other'],
  ['051', 'parenteral'],
  ['052', 'periarticular'],
  ['053', 'perineural'],
  ['054', 'rectal'],
  ['055', 'respiratory (inhalation)'],
  ['056', 'retrobulbar'],
  ['057', 'subconjunctival'],
  ['058', 'subcutaneous'],
  ['059', 'subdermal'],
  ['060', 'sublingual'],
  ['061', 'topical'],
  ['062', 'transdermal'],
  ['063', 'transmammary'],
  ['064', 'transplacental'],
  ['065', 'unknown'],
  ['066', 'urethral'],
  ['067', 'vaginal'],
]);

/** `patient.reaction.reactionoutcome` — the reaction's outcome at last observation. */
export const REACTION_OUTCOMES: ReadonlyMap<string, string> = new Map([
  ['1', 'recovered/resolved'],
  ['2', 'recovering/resolving'],
  ['3', 'not recovered/not resolved'],
  ['4', 'recovered/resolved with sequelae (consequent health issues)'],
  ['5', 'fatal'],
  ['6', 'unknown'],
]);

/** `patient.patientagegroup`. */
export const PATIENT_AGE_GROUPS: ReadonlyMap<string, string> = new Map([
  ['1', 'neonate'],
  ['2', 'infant'],
  ['3', 'child'],
  ['4', 'adolescent'],
  ['5', 'adult'],
  ['6', 'elderly'],
]);

/** `patient.patientonsetageunit` — the unit of `patient.patientonsetage`. */
export const ONSET_AGE_UNITS: ReadonlyMap<string, string> = new Map([
  ['800', 'decade'],
  ['801', 'year'],
  ['802', 'month'],
  ['803', 'week'],
  ['804', 'day'],
  ['805', 'hour'],
]);

/** `patient.drug.actiondrug` — the action taken with the drug. */
export const DRUG_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['1', 'drug withdrawn'],
  ['2', 'dose reduced'],
  ['3', 'dose increased'],
  ['4', 'dose not changed'],
  ['5', 'unknown'],
  ['6', 'not applicable'],
]);

/**
 * `patient.drug.drugadditional` — dechallenge: whether the reaction abated once
 * the drug was stopped or its dose reduced. openFDA also stores an undefined `4`.
 */
export const DECHALLENGE_OUTCOMES: ReadonlyMap<string, string> = new Map([
  ['1', 'yes'],
  ['2', 'no'],
  ['3', 'does not apply'],
]);

/** `patient.drug.drugrecurreadministration` — rechallenge: whether the reaction recurred on readministration. */
export const RECHALLENGE_OUTCOMES: ReadonlyMap<string, string> = new Map([
  ['1', 'yes'],
  ['2', 'no'],
  ['3', 'unknown'],
]);

/** `patient.drug.drugtreatmentdurationunit` — the unit of `drugtreatmentduration`. */
export const TREATMENT_DURATION_UNITS: ReadonlyMap<string, string> = new Map([
  ['801', 'year'],
  ['802', 'month'],
  ['803', 'week'],
  ['804', 'day'],
  ['805', 'hour'],
  ['806', 'minute'],
]);

/**
 * `patient.drug.drugintervaldosagedefinition` — the unit of
 * `drugintervaldosageunitnumb`. FDA's reference labels both `807` and `811`
 * "Trimester", so `807` is left out and renders raw.
 */
export const DOSAGE_INTERVAL_UNITS: ReadonlyMap<string, string> = new Map([
  ['801', 'year'],
  ['802', 'month'],
  ['803', 'week'],
  ['804', 'day'],
  ['805', 'hour'],
  ['806', 'minute'],
  ['810', 'cyclical'],
  ['811', 'trimester'],
  ['812', 'as necessary'],
  ['813', 'total'],
]);

/**
 * `patient.drug.drugstructuredosageunit` and `drugcumulativedosageunit`, which
 * share one list. FDA's reference labels `001`–`004` only; openFDA stores codes
 * from `005` up as well, and those render raw.
 */
export const DOSE_UNITS: ReadonlyMap<string, string> = new Map([
  ['001', 'kg (kilograms)'],
  ['002', 'g (grams)'],
  ['003', 'mg (milligrams)'],
  ['004', 'µg (micrograms)'],
]);

/** `reporttype` — the circumstances under which the report was generated. */
export const REPORT_TYPES: ReadonlyMap<string, string> = new Map([
  ['1', 'spontaneous'],
  ['2', 'report from study'],
  ['3', 'other'],
  ['4', 'not available to sender (unknown)'],
]);

/** `primarysource.qualification` — who submitted the report. */
export const REPORTER_QUALIFICATIONS: ReadonlyMap<string, string> = new Map([
  ['1', 'physician'],
  ['2', 'pharmacist'],
  ['3', 'other health professional'],
  ['4', 'lawyer'],
  ['5', 'consumer or non-health professional'],
]);

/** `sender.sendertype` — FDA's reference labels `2` only; openFDA also stores `1`, `4`, and `6`. */
export const SENDER_TYPES: ReadonlyMap<string, string> = new Map([['2', 'regulatory authority']]);

/** `receiver.receivertype`. */
export const RECEIVER_TYPES: ReadonlyMap<string, string> = new Map([['6', 'other']]);

/**
 * `fulfillexpeditecriteria` — whether the report was expedited. FDA's reference
 * labels `1` and `2` only; openFDA also stores `3`, `4`, and `5`.
 */
export const EXPEDITED_REPORT_FLAGS: ReadonlyMap<string, string> = new Map([
  ['1', 'yes'],
  ['2', 'no'],
]);

/**
 * A coded value as `label (code)` when the table holds that exact string; any
 * other value — a name such as `ORAL`, an unpadded number, a code past the
 * table, a non-string — comes back unchanged.
 */
export function codeLabel(codes: ReadonlyMap<string, string>, value: unknown): unknown {
  const label = typeof value === 'string' ? codes.get(value) : undefined;
  return label === undefined ? value : `${label} (${value})`;
}

/**
 * Which code table decodes each field of a record — a table for a field holding
 * a code, a nested spec for a field holding an object (`primarysource`, whose
 * `qualification` is coded).
 */
export interface CodeLabelSpec {
  readonly [field: string]: ReadonlyMap<string, string> | CodeLabelSpec;
}

/**
 * A shallow copy of `record` with each field `spec` names rendered through
 * {@link codeLabel}, recursing into a nested spec when the field holds a plain
 * object. Only own fields are touched, no field is added, and key order is kept,
 * so `formatRemainingFields` renders the copy in the record's own order.
 */
export function withCodeLabels(
  record: Record<string, unknown>,
  spec: CodeLabelSpec,
): Record<string, unknown> {
  const labelled = { ...record };
  for (const [field, codes] of Object.entries(spec)) {
    if (!Object.hasOwn(labelled, field)) continue;
    const value = labelled[field];
    if (isCodeTable(codes)) labelled[field] = codeLabel(codes, value);
    else if (isPlainRecord(value)) labelled[field] = withCodeLabels(value, codes);
  }
  return labelled;
}

function isCodeTable(
  codes: ReadonlyMap<string, string> | CodeLabelSpec,
): codes is ReadonlyMap<string, string> {
  return codes instanceof Map;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `code = label` pairs joined by `, ` for a field catalog note — every code in
 * the table, or the listed ones in the order given. Throws on a listed code the
 * table lacks, which is a typo in the catalog.
 */
export function codeList(codes: ReadonlyMap<string, string>, only?: readonly string[]): string {
  return (only ?? [...codes.keys()])
    .map((code) => {
      const label = codes.get(code);
      if (label === undefined) throw new Error(`No label for code ${code}`);
      return `${code} = ${label}`;
    })
    .join(', ');
}
