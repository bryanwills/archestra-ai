import type * as k8s from "@kubernetes/client-node";
import {
  buildManagedAwsApplicationNetworkPolicy,
  buildManagedCiliumNetworkPolicy,
  buildManagedGkeFqdnNetworkPolicy,
  buildManagedNetworkPolicy,
  constructManagedNetworkPolicyName,
  shouldManageK8sNetworkPolicy,
  shouldUseAwsApplicationNetworkPolicy,
  shouldUseCiliumNetworkPolicy,
  shouldUseGkeFqdnNetworkPolicy,
} from "@/k8s/mcp-server-runtime/network-policy";
import type {
  EffectiveNetworkPolicy,
  K8sNetworkPolicyCapabilities,
} from "@/types";

/**
 * Per-environment Dagger engine egress policy — a thin reuse of the MCP
 * server-runtime network-policy machinery.
 *
 * The Dagger engine pod is the chokepoint all sandbox exec traffic SNATs through
 * (it leaves the pod with the engine pod's IP), so a pod-level egress policy on
 * the engine governs the execs. We therefore apply the *same* egress policy an
 * MCP server in the environment would get, just targeting the engine pod's
 * labels. The provider selection (plain NetworkPolicy / Cilium / GKE FQDN / AWS)
 * mirrors `K8sDeployment.applyK8sNetworkPolicy` exactly — see DESIGN.md.
 */

const DAGGER_ENGINE_APP_LABEL = "dagger-engine";

/** RFC1123 deployment name for an environment's dedicated Dagger engine. */
export function daggerEngineDeploymentName(environmentId: string): string {
  return `dagger-engine-${environmentId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 253)
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/g, "");
}

/** Labels stamped on the engine pod and matched by its egress policy. */
export function daggerEnginePodLabels(
  environmentId: string,
): Record<string, string> {
  return {
    app: DAGGER_ENGINE_APP_LABEL,
    "dagger-environment-id": environmentId,
  };
}

/** A network-policy object ready to apply, tagged with its kind/CRD. */
export type DaggerEgressPolicyObject =
  | { kind: "NetworkPolicy"; object: k8s.V1NetworkPolicy }
  | {
      kind:
        | "CiliumNetworkPolicy"
        | "FQDNNetworkPolicy"
        | "ApplicationNetworkPolicy";
      object: Record<string, unknown>;
    };

/**
 * Build the network-policy object(s) to apply to an environment's Dagger engine
 * pod, given the environment's effective egress policy and the cluster's CNI
 * capabilities. Pure — performs no cluster calls — so it is unit-testable.
 *
 * `unrestricted` (and the built-in default) get an open-egress floor: all public
 * egress is allowed, private/link-local ranges are not. `off`/`restricted` use
 * the shared MCP builders, mirroring the provider precedence in
 * `K8sDeployment.applyK8sNetworkPolicy`: Cilium > GKE-FQDN > AWS > Kubernetes
 * (the GKE-FQDN path additionally emits a plain NetworkPolicy for the CIDR rules).
 */
export function buildDaggerEgressPolicies(params: {
  environmentId: string;
  effectivePolicy: EffectiveNetworkPolicy;
  capabilities?: K8sNetworkPolicyCapabilities | null;
  /**
   * Resolved by the caller; only the AWS ApplicationNetworkPolicy consumes it.
   * Omitted (or empty) falls back to allowing DNS egress to any IP — the same
   * degraded mode the MCP path uses when the cluster DNS IP can't be resolved.
   */
  clusterDnsIps?: string[];
  /**
   * Extra IPv4 CIDRs to block from the unrestricted floor's public-egress rule,
   * on top of the built-in RFC1918/link-local/metadata ranges. Set to the
   * cluster's Service and Pod CIDRs when they fall outside RFC1918 (common on
   * GKE and other managed clusters) so sandboxed code can't reach in-cluster
   * ClusterIP services. Only consumed by the floor.
   */
  additionalDeniedCidrs?: string[];
}): DaggerEgressPolicyObject[] {
  const { environmentId, effectivePolicy, capabilities } = params;
  const clusterDnsIps = params.clusterDnsIps ?? [];

  const podSelectorLabels = daggerEnginePodLabels(environmentId);
  const name = constructManagedNetworkPolicyName(
    daggerEngineDeploymentName(environmentId),
  );

  if (!shouldManageK8sNetworkPolicy(effectivePolicy)) {
    // unrestricted / built-in default: open public egress, private ranges blocked.
    return [
      {
        kind: "NetworkPolicy",
        object: buildUnrestrictedFloorPolicy({
          name,
          podSelectorLabels,
          additionalDeniedCidrs: params.additionalDeniedCidrs ?? [],
          clusterDnsIps,
        }),
      },
    ];
  }

  if (shouldUseCiliumNetworkPolicy({ effectivePolicy, capabilities })) {
    return [
      {
        kind: "CiliumNetworkPolicy",
        object: buildManagedCiliumNetworkPolicy({
          name,
          podSelectorLabels,
          effectivePolicy,
        }),
      },
    ];
  }

  if (shouldUseGkeFqdnNetworkPolicy({ effectivePolicy, capabilities })) {
    return [
      {
        kind: "FQDNNetworkPolicy",
        object: buildManagedGkeFqdnNetworkPolicy({
          name,
          podSelectorLabels,
          effectivePolicy,
        }),
      },
      {
        kind: "NetworkPolicy",
        object: buildManagedNetworkPolicy({
          name,
          podSelectorLabels,
          effectivePolicy,
        }),
      },
    ];
  }

  if (shouldUseAwsApplicationNetworkPolicy({ effectivePolicy, capabilities })) {
    return [
      {
        kind: "ApplicationNetworkPolicy",
        object: buildManagedAwsApplicationNetworkPolicy({
          name,
          podSelectorLabels,
          effectivePolicy,
          clusterDnsIps,
        }),
      },
    ];
  }

  return [
    {
      kind: "NetworkPolicy",
      object: buildManagedNetworkPolicy({
        name,
        podSelectorLabels,
        effectivePolicy,
      }),
    },
  ];
}

// Private/link-local ranges excluded from the open-egress floor.
const FLOOR_DENIED_IPV4_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "0.0.0.0/32",
];
const FLOOR_DENIED_IPV6_CIDRS = ["::1/128", "fc00::/7", "fe80::/10"];

// Open-egress floor for `unrestricted` engines: DNS + all public egress with the
// ranges above blocked. `additionalDeniedCidrs` extends the IPv4 block list with
// operator-supplied ranges (e.g. a cluster's Service/Pod CIDRs outside RFC1918).
function buildUnrestrictedFloorPolicy(params: {
  name: string;
  podSelectorLabels: Record<string, string>;
  additionalDeniedCidrs: string[];
  clusterDnsIps: string[];
}): k8s.V1NetworkPolicy {
  const deniedIpv4 = [
    ...FLOOR_DENIED_IPV4_CIDRS,
    ...params.additionalDeniedCidrs,
  ];
  const dnsPorts = [
    { protocol: "UDP", port: 53 as unknown as k8s.IntOrString },
    { protocol: "TCP", port: 53 as unknown as k8s.IntOrString },
  ];
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: params.name,
      labels: {
        "app.kubernetes.io/managed-by": "archestra",
        "archestra.io/resource": "dagger-egress-policy",
      },
    },
    spec: {
      podSelector: { matchLabels: params.podSelectorLabels },
      policyTypes: ["Egress"],
      egress: [
        // DNS on :53 to any resolver — kept ports-only so a link-local
        // NodeLocal DNSCache resolver (denied by the private floor below) keeps
        // working on providers that front cluster DNS with one.
        { ports: dnsPorts },
        // The AWS ApplicationNetworkPolicy agent ignores a ports-only rule with
        // no `to`, and the cluster resolver sits in the except-denied private
        // range, so also allow :53 to the resolver IPs explicitly. Additive —
        // leaves the rule above intact for every other provider.
        ...(params.clusterDnsIps.length > 0
          ? [
              {
                to: params.clusterDnsIps.map((ip) => ({
                  ipBlock: {
                    cidr: ip.includes("/")
                      ? ip
                      : ip.includes(":")
                        ? `${ip}/128`
                        : `${ip}/32`,
                  },
                })),
                ports: dnsPorts,
              },
            ]
          : []),
        {
          to: [{ ipBlock: { cidr: "0.0.0.0/0", except: deniedIpv4 } }],
        },
        {
          to: [{ ipBlock: { cidr: "::/0", except: FLOOR_DENIED_IPV6_CIDRS } }],
        },
      ],
    },
  };
}
