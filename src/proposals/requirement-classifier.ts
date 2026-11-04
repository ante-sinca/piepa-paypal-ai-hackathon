export type RequirementClassification = Readonly<{
  missingInstructionFields: readonly string[];
  deferredWorkflowRequirements: readonly string[];
  unresolvedPrerequisites: readonly string[];
  diagnostics: readonly string[];
}>;

const missingInstructionAliases = new Set(["collectionamount", "collectioncurrency", "collectionprovider", "paymentpurpose", "beneficiary", "beneficiaryreference", "beneficiarycountry", "recipient", "institutionalrecipient", "institutionrecipient"]);
const deferredAliases = new Set(["approval", "humanapproval", "operatorapproval", "explicithumanapproval", "paymentevidence", "paymentverification", "verifiedpayment", "paymentresourceretrieved", "paymentcaptured", "funding", "settlement", "execution"]);
const prerequisiteAliases = new Set(["permission", "permissions", "providerpermission", "providerpermissions", "institutionalpermission", "institutionalpermissions"]);

/**
 * Canonicalises untrusted model labels for display and routing only. Readiness
 * is determined separately from source-backed proposal fields and schema rules.
 */
export function classifyRequirementLabels(labels: readonly string[]): RequirementClassification {
  const missingInstructionFields: string[] = []; const deferredWorkflowRequirements: string[] = []; const unresolvedPrerequisites: string[] = []; const diagnostics: string[] = [];
  for (const label of labels) {
    const key = label.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (missingInstructionAliases.has(key)) missingInstructionFields.push(label);
    else if (deferredAliases.has(key)) deferredWorkflowRequirements.push(label);
    else if (prerequisiteAliases.has(key)) unresolvedPrerequisites.push(label);
    else diagnostics.push(label);
  }
  return { missingInstructionFields: unique(missingInstructionFields), deferredWorkflowRequirements: unique(deferredWorkflowRequirements), unresolvedPrerequisites: unique(unresolvedPrerequisites), diagnostics: unique(diagnostics) };
}

const unique = (values: readonly string[]) => [...new Set(values)];
