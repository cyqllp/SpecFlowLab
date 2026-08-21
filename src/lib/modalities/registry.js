export const MODALITY_REGISTRY_SCHEMA = "specflowlab.modality_registry.v1";

const TECHNIQUES = Object.freeze([
  technique("unknown", "Unknown / not recorded", "unknown", [], "metadata-only"),
  technique("fsta", "Femtosecond transient absorption (fsTA)", "transient-matrix", [axis("time", "ps"), axis("wavelength", "nm")], "implemented"),
  technique("psta", "Picosecond transient absorption (psTA)", "transient-matrix", [axis("time", "ps"), axis("wavelength", "nm")], "metadata-only"),
  technique("nsta", "Nanosecond transient absorption (nsTA)", "transient-matrix", [axis("time", "ns"), axis("wavelength", "nm")], "metadata-only"),
  technique("absorption", "Steady-state absorption", "one-dimensional-spectrum", [axis("wavelength", "nm")], "metadata-only"),
  technique("pl", "Photoluminescence", "one-dimensional-spectrum", [axis("emission wavelength", "nm")], "metadata-only"),
  technique("trpl", "Time-resolved photoluminescence", "one-dimensional-trace", [axis("time", "ps")], "metadata-only"),
  technique("epr", "EPR", "one-dimensional-spectrum", [axis("magnetic field", "mT")], "metadata-only"),
  technique("ir", "Infrared spectroscopy", "one-dimensional-spectrum", [axis("wavenumber", "cm^-1")], "metadata-only"),
  technique("raman", "Raman spectroscopy", "one-dimensional-spectrum", [axis("Raman shift", "cm^-1")], "metadata-only"),
  technique("nmr", "NMR", "one-dimensional-spectrum", [axis("chemical shift", "ppm")], "metadata-only"),
  technique("electrochemistry", "Electrochemistry", "one-dimensional-trace", [axis("potential", "V")], "metadata-only"),
  technique("sec", "Spectroelectrochemistry", "spectrum-series", [axis("wavelength", "nm"), axis("potential", "V")], "metadata-only"),
  technique("calculation", "Calculation", "table", [], "metadata-only"),
  technique("generic-spectrum", "Generic spectrum", "one-dimensional-spectrum", [axis("x", "user-defined")], "foundation"),
  technique("generic-trace", "Generic trace", "one-dimensional-trace", [axis("x", "user-defined")], "foundation"),
  technique("generic-table", "Generic table", "table", [], "foundation"),
  technique("other", "Other / custom technique", "custom", [], "foundation"),
]);

export function listTechniques() {
  return TECHNIQUES.map(clone);
}

export function getTechnique(id) {
  return clone(TECHNIQUES.find((item) => item.id === id) ?? TECHNIQUES[0]);
}

export function validateNativeModalityRecord(record) {
  const techniqueRecord = getTechnique(record?.techniqueId);
  if (!record?.nativeShape) throw new Error("A modality record requires its native shape.");
  if (techniqueRecord.nativeShape !== "unknown" && techniqueRecord.nativeShape !== "custom" && record.nativeShape !== techniqueRecord.nativeShape) {
    throw new Error(`${techniqueRecord.label} must retain its ${techniqueRecord.nativeShape} native shape.`);
  }
  const axes = Array.isArray(record.axes) ? record.axes : [];
  axes.forEach((item) => {
    if (!item.name || !item.unit) throw new Error("Every modality axis requires a name and unit.");
    if (Array.isArray(item.values) && item.values.some((value) => value !== null && !Number.isFinite(value))) {
      throw new Error("Modality axes may contain finite values or explicit null missing values only.");
    }
  });
  return record;
}

function technique(id, label, nativeShape, axes, adapterStatus) {
  return { id, label, nativeShape, axes, adapterStatus };
}

function axis(name, unit) {
  return { name, unit };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
