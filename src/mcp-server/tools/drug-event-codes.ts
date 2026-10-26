/**
 * @fileoverview Code tables for the coded `drug/event` fields openFDA returns as
 * bare strings: `patient.drug.drugadministrationroute` (zero-padded `001`–`067`),
 * `patient.reaction.reactionoutcome` (`1`–`6`), and `patient.patientagegroup`
 * (`1`–`6`). One source for both the code meanings `openfda_search_adverse_events`
 * renders in `content[]` and the field catalog notes `openfda_describe_fields`
 * serves.
 *
 * Labels are transcribed from FDA's drug/event field reference
 * (https://open.fda.gov/fields/drugevent.yaml), lower-cased, with two of its
 * misspellings corrected: `049` "Oropharingeal" → oropharyngeal and `057`
 * "Sunconjunctival" → subconjunctival.
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
