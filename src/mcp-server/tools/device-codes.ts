/**
 * @fileoverview Code tables for the coded `device/classification` fields openFDA
 * returns as bare strings — `device_class` and `submission_type_id`. One source
 * for both the labels `openfda_search_device_clearances` renders in `content[]`
 * and the field catalog notes `openfda_describe_fields` serves.
 * @module mcp-server/tools/device-codes
 */

/** `device_class` labels from openFDA's field reference, keyed on the stored spelling — HDE is stored lowercase `f`. */
export const DEVICE_CLASSES: ReadonlyMap<string, string> = new Map([
  ['1', 'Class I'],
  ['2', 'Class II'],
  ['3', 'Class III'],
  ['U', 'unclassified'],
  ['N', 'not classified'],
  ['f', 'HDE'],
]);

/** `submission_type_id` labels; openFDA's reference defines 1–4, and the 6, 7, and 8 it also stores render as sent. */
export const SUBMISSION_TYPES: ReadonlyMap<string, string> = new Map([
  ['1', '510(k)'],
  ['2', 'PMA'],
  ['3', 'contact ODE'],
  ['4', '510(k) exempt'],
]);
