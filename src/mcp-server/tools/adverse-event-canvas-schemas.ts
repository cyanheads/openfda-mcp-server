/**
 * @fileoverview Staged table columns for `openfda_search_adverse_events`: one
 * fixed column list per category, registered when a call stages its matches.
 * @module mcp-server/tools/adverse-event-canvas-schemas
 */

import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';

/**
 * Canvas table projections per category — each call stages one category, so the
 * schema is selected by `input.category`. Each list holds one column per
 * top-level field its endpoint returns (verified live), fixed so two stagings of
 * one category always union. None holds a top-level `openfda` column: no
 * adverse-event record carries one (drug reports nest the block under
 * `patient.drug`, device reports under `device`). Scalars are VARCHAR (openFDA
 * returns most values as strings; CAST in SQL for math); nested objects/arrays
 * are JSON columns. All nullable — openFDA records are sparse. A device report
 * sends most of its fields on every record, as `''` when unset, so those
 * columns read `''` rather than NULL. The drug and device lists keep their
 * 0.10.0 columns in their 0.10.0 relative order, grouped by subject, JSON last.
 */
export const ADVERSE_EVENT_SCHEMAS = {
  drug: [
    // Report identity
    { name: 'safetyreportid', type: 'VARCHAR', nullable: true },
    { name: 'safetyreportversion', type: 'VARCHAR', nullable: true },
    { name: 'reporttype', type: 'VARCHAR', nullable: true },
    { name: 'fulfillexpeditecriteria', type: 'VARCHAR', nullable: true },
    // Dates, each with its format code
    { name: 'receivedate', type: 'VARCHAR', nullable: true },
    { name: 'receivedateformat', type: 'VARCHAR', nullable: true },
    { name: 'receiptdate', type: 'VARCHAR', nullable: true },
    { name: 'receiptdateformat', type: 'VARCHAR', nullable: true },
    { name: 'transmissiondate', type: 'VARCHAR', nullable: true },
    { name: 'transmissiondateformat', type: 'VARCHAR', nullable: true },
    // Seriousness
    { name: 'serious', type: 'VARCHAR', nullable: true },
    { name: 'seriousnessdeath', type: 'VARCHAR', nullable: true },
    { name: 'seriousnesshospitalization', type: 'VARCHAR', nullable: true },
    { name: 'seriousnesslifethreatening', type: 'VARCHAR', nullable: true },
    { name: 'seriousnessdisabling', type: 'VARCHAR', nullable: true },
    { name: 'seriousnesscongenitalanomali', type: 'VARCHAR', nullable: true },
    { name: 'seriousnessother', type: 'VARCHAR', nullable: true },
    // Countries
    { name: 'occurcountry', type: 'VARCHAR', nullable: true },
    { name: 'primarysourcecountry', type: 'VARCHAR', nullable: true },
    // Case numbers and earlier versions
    { name: 'companynumb', type: 'VARCHAR', nullable: true },
    { name: 'authoritynumb', type: 'VARCHAR', nullable: true },
    { name: 'duplicate', type: 'VARCHAR', nullable: true },
    // Nested — `reportduplicate` is an object on some reports and an array on others
    { name: 'patient', type: 'JSON', nullable: true },
    { name: 'primarysource', type: 'JSON', nullable: true },
    { name: 'sender', type: 'JSON', nullable: true },
    { name: 'receiver', type: 'JSON', nullable: true },
    { name: 'reportduplicate', type: 'JSON', nullable: true },
  ],
  food: [
    { name: 'report_number', type: 'VARCHAR', nullable: true },
    { name: 'date_created', type: 'VARCHAR', nullable: true },
    { name: 'date_started', type: 'VARCHAR', nullable: true },
    { name: 'outcomes', type: 'JSON', nullable: true },
    { name: 'reactions', type: 'JSON', nullable: true },
    { name: 'products', type: 'JSON', nullable: true },
    { name: 'consumer', type: 'JSON', nullable: true },
  ],
  device: [
    // Report identity and source
    { name: 'report_number', type: 'VARCHAR', nullable: true },
    { name: 'mdr_report_key', type: 'VARCHAR', nullable: true },
    { name: 'event_key', type: 'VARCHAR', nullable: true },
    { name: 'report_source_code', type: 'VARCHAR', nullable: true },
    { name: 'mfr_report_type', type: 'VARCHAR', nullable: true },
    { name: 'summary_report_flag', type: 'VARCHAR', nullable: true },
    { name: 'noe_summarized', type: 'VARCHAR', nullable: true },
    // Event, device use, and correction
    { name: 'event_type', type: 'VARCHAR', nullable: true },
    { name: 'adverse_event_flag', type: 'VARCHAR', nullable: true },
    { name: 'product_problem_flag', type: 'VARCHAR', nullable: true },
    { name: 'event_location', type: 'VARCHAR', nullable: true },
    { name: 'number_devices_in_event', type: 'VARCHAR', nullable: true },
    { name: 'number_patients_in_event', type: 'VARCHAR', nullable: true },
    { name: 'previous_use_code', type: 'VARCHAR', nullable: true },
    { name: 'single_use_flag', type: 'VARCHAR', nullable: true },
    { name: 'reprocessed_and_reused_flag', type: 'VARCHAR', nullable: true },
    { name: 'removal_correction_number', type: 'VARCHAR', nullable: true },
    // Dates
    { name: 'date_received', type: 'VARCHAR', nullable: true },
    { name: 'date_of_event', type: 'VARCHAR', nullable: true },
    { name: 'date_report', type: 'VARCHAR', nullable: true },
    { name: 'report_date', type: 'VARCHAR', nullable: true },
    { name: 'date_facility_aware', type: 'VARCHAR', nullable: true },
    { name: 'date_manufacturer_received', type: 'VARCHAR', nullable: true },
    { name: 'date_report_to_fda', type: 'VARCHAR', nullable: true },
    { name: 'date_report_to_manufacturer', type: 'VARCHAR', nullable: true },
    { name: 'device_date_of_manufacturer', type: 'VARCHAR', nullable: true },
    { name: 'date_added', type: 'VARCHAR', nullable: true },
    { name: 'date_changed', type: 'VARCHAR', nullable: true },
    { name: 'suppl_dates_fda_received', type: 'VARCHAR', nullable: true },
    { name: 'suppl_dates_mfr_received', type: 'VARCHAR', nullable: true },
    // Reporter
    { name: 'reporter_occupation_code', type: 'VARCHAR', nullable: true },
    { name: 'health_professional', type: 'VARCHAR', nullable: true },
    { name: 'initial_report_to_fda', type: 'VARCHAR', nullable: true },
    { name: 'report_to_fda', type: 'VARCHAR', nullable: true },
    { name: 'report_to_manufacturer', type: 'VARCHAR', nullable: true },
    { name: 'reporter_country_code', type: 'VARCHAR', nullable: true },
    { name: 'reporter_state_code', type: 'VARCHAR', nullable: true },
    // Premarket submission or exemption
    { name: 'pma_pmn_number', type: 'VARCHAR', nullable: true },
    { name: 'exemption_number', type: 'VARCHAR', nullable: true },
    // Suspect-device manufacturer
    { name: 'manufacturer_name', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_address_1', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_address_2', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_city', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_state', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_zip_code', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_zip_code_ext', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_postal_code', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_country', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_link_flag', type: 'VARCHAR', nullable: true },
    // Manufacturer contact
    { name: 'manufacturer_contact_t_name', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_f_name', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_l_name', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_address_1', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_address_2', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_city', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_state', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_zip_code', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_zip_ext', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_postal_code', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_country', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_pcity', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_pcountry', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_area_code', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_exchange', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_phone_number', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_extension', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_contact_plocal', type: 'VARCHAR', nullable: true },
    // Device manufacturer (report section G1)
    { name: 'manufacturer_g1_name', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_g1_address_1', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_g1_address_2', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_g1_city', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_g1_state', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_g1_zip_code', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_g1_zip_code_ext', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_g1_postal_code', type: 'VARCHAR', nullable: true },
    { name: 'manufacturer_g1_country', type: 'VARCHAR', nullable: true },
    // User facility or importer (distributor)
    { name: 'distributor_name', type: 'VARCHAR', nullable: true },
    { name: 'distributor_address_1', type: 'VARCHAR', nullable: true },
    { name: 'distributor_address_2', type: 'VARCHAR', nullable: true },
    { name: 'distributor_city', type: 'VARCHAR', nullable: true },
    { name: 'distributor_state', type: 'VARCHAR', nullable: true },
    { name: 'distributor_zip_code', type: 'VARCHAR', nullable: true },
    { name: 'distributor_zip_code_ext', type: 'VARCHAR', nullable: true },
    // Nested records and lists
    { name: 'device', type: 'JSON', nullable: true },
    { name: 'patient', type: 'JSON', nullable: true },
    { name: 'mdr_text', type: 'JSON', nullable: true },
    { name: 'product_problems', type: 'JSON', nullable: true },
    { name: 'remedial_action', type: 'JSON', nullable: true },
    { name: 'source_type', type: 'JSON', nullable: true },
    { name: 'type_of_report', type: 'JSON', nullable: true },
  ],
  // Every top-level field a cosmetic report carries.
  cosmetic: [
    { name: 'report_number', type: 'VARCHAR', nullable: true },
    { name: 'report_version', type: 'VARCHAR', nullable: true },
    { name: 'report_type', type: 'VARCHAR', nullable: true },
    { name: 'initial_received_date', type: 'VARCHAR', nullable: true },
    { name: 'latest_received_date', type: 'VARCHAR', nullable: true },
    { name: 'event_date', type: 'VARCHAR', nullable: true },
    { name: 'legacy_report_id', type: 'VARCHAR', nullable: true },
    { name: 'meddra_version', type: 'VARCHAR', nullable: true },
    { name: 'patient', type: 'JSON', nullable: true },
    { name: 'products', type: 'JSON', nullable: true },
    { name: 'reactions', type: 'JSON', nullable: true },
    { name: 'outcomes', type: 'JSON', nullable: true },
  ],
} satisfies Record<string, ColumnSchema[]>;
