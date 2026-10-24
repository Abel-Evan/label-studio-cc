/**
 * Helpers for the per-region Number control in this fork.
 *
 * The jersey-number workflow uses a per-region `<Number name="number">` control. Because the
 * project was migrated from a TextArea to a Number while keeping the same result name, the value
 * may be persisted in TextArea form (`result.type === "textarea"`, value under `value.text`)
 * instead of `value.number`. These helpers mirror `Number.jsx#needsUpdate`'s fallback so the value
 * can be read consistently from a region.
 */

// The number result attached to a region, if any.
export const getRegionNumberResult = (region: any) =>
  region?.results?.find((r: any) => r.from_name?.type === "number") ?? null;

// Numeric value of a region, or null when absent/unparseable.
export const getRegionNumber = (region: any): number | null => {
  const result = getRegionNumberResult(region);

  if (!result) return null;

  let value = result.mainValue; // value[from_name.valueType] === value.number

  if (value === undefined || value === null) {
    const text = result.value?.text;
    const parsed = Number(Array.isArray(text) ? text[0] : text);

    value = Number.isNaN(parsed) ? null : parsed;
  }

  return typeof value === "number" ? value : null;
};

// "Empty" for this workflow means unset OR 0 (jersey numbers start at 1, so 0 == "not filled").
export const isRegionNumberEmpty = (region: any): boolean => {
  const value = getRegionNumber(region);

  return value === null || value === undefined || value === 0;
};

// Whether the labeling config declares a per-region Number control. Gates all custom UX so other
// projects (without such a control) are left untouched.
export const hasPerRegionNumber = (annotation: any): boolean => {
  const names = annotation?.names;

  if (!names?.values) return false;

  return Array.from(names.values()).some((tag: any) => tag?.type === "number" && tag?.perregion);
};

// Select the first region (in list order) whose number is empty. Returns the region or null.
export const selectFirstEmptyNumberRegion = (annotation: any) => {
  const regions: any[] = annotation?.regionStore?.regions ?? [];
  const target = regions.find(isRegionNumberEmpty);

  if (target) annotation.selectArea(target);

  return target ?? null;
};

// Select the next region after `currentRegion` whose number is empty. No wrap-around: when nothing
// is left after the current one, returns null and leaves the selection untouched ("没有了就停止").
export const selectNextEmptyNumberRegion = (annotation: any, currentRegion: any) => {
  const regions: any[] = annotation?.regionStore?.regions ?? [];
  const from = currentRegion ? regions.indexOf(currentRegion) : -1;

  for (let i = from + 1; i < regions.length; i++) {
    if (isRegionNumberEmpty(regions[i])) {
      annotation.selectArea(regions[i]);
      return regions[i];
    }
  }

  return null;
};
