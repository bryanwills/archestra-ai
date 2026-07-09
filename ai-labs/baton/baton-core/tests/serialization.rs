//! serde surface: the audit trail and contracts round-trip through JSON, and a
//! `Decision` is observable on the wire. The capability boundary is exercised
//! too — pure data round-trips, while `Decision`/`Permit` only serialize (there
//! is no `Deserialize` to forge a permit from).

use baton_core::{
    Audience, AudienceRule, AuditEntry, Authority, AuthorityName, Breach, Decision, Effect, Effects, Grant, KnownTrust,
    Label, PolicyEngine, Requirements, Ruling, ToolContract, ToolName, ToolRequest, Trajectory, Trust, UnknownPolicy,
    Unprovable, UserId, Violation,
};

fn roundtrip<T>(value: &T) -> T
where
    T: serde::Serialize + serde::de::DeserializeOwned,
{
    serde_json::from_str(&serde_json::to_string(value).expect("serialize")).expect("deserialize")
}

#[test]
fn label_with_full_audit_round_trips() {
    let label = Label {
        audience: Audience::readers([UserId::new("alice"), UserId::new("bob")]),
        trust: Trust::SUSPICIOUS,
        effects: Effects::declared([Effect::Egress, Effect::Mutation]),
        audit: vec![
            AuditEntry::Acknowledged {
                tool: ToolName::new("calendar.lookup"),
                facts: vec![Violation::Unprovable(Unprovable::NoContract {
                    tool: ToolName::new("calendar.lookup"),
                })],
                by: None,
            },
            AuditEntry::Declassified {
                grant: Grant {
                    trust: Some(KnownTrust::Trusted),
                    ..Grant::empty()
                },
                resolved: vec![Violation::Breach(Breach::TrustBelow {
                    required: KnownTrust::Trusted,
                    actual: KnownTrust::Suspicious,
                })],
                authority: AuthorityName::new("human-in-the-loop"),
                reason: "reviewed the provenance".to_owned(),
            },
        ],
    };
    assert_eq!(label, roundtrip(&label));
}

#[test]
fn tool_contract_round_trips() {
    let contract = ToolContract {
        name: ToolName::new("report.generate"),
        requires: Requirements {
            trust: Some(KnownTrust::Trusted),
            audience: AudienceRule::RecipientsWithinContext,
            forbid_prior_effects: [Effect::Egress].into_iter().collect(),
            ..Requirements::default()
        },
        output_label: Label::identity(),
    };
    assert_eq!(contract, roundtrip(&contract));
}

#[test]
fn effects_deserialization_denies_an_unknown_effect() {
    let effects = Effects::declared([Effect::Egress]);
    let json = serde_json::to_string(&effects).unwrap();
    // The legible list form round-trips.
    assert_eq!(effects, serde_json::from_str::<Effects>(&json).unwrap());
    // An unrecognized effect fails deserialization closed rather than being
    // silently dropped to a weaker set.
    let tampered = json.replace("Egress", "Teleport");
    assert!(serde_json::from_str::<Effects>(&tampered).is_err());
}

/// An authority that rules on nothing — enough to type a `PolicyEngine` for the
/// decision-observability test, which drives only clean and structurally-blocked
/// flows (neither consults an authority).
struct NoAuthority;

impl Authority for NoAuthority {
    fn rule(&self, _: &Grant, _: &ToolRequest, _: &Label, _: &[Violation]) -> Option<(AuthorityName, Ruling)> {
        None
    }
}

#[test]
fn a_permitted_decision_and_its_result_label_serialize() {
    let mut engine = PolicyEngine::new(NoAuthority, UnknownPolicy::AllowWithAudit);
    engine
        .register(ToolContract {
            name: ToolName::new("noop"),
            requires: Requirements::default(),
            output_label: Label::identity(),
        })
        .unwrap();

    let decision = engine.evaluate(&Trajectory::new(), &ToolRequest::new(ToolName::new("noop")));
    let Decision::Permitted(permit) = &decision else {
        panic!("expected a permitted decision, got {decision:?}");
    };
    // The whole decision serializes (exercises Permit + TrajectoryId Serialize);
    // its result label — which is `Deserialize` — round-trips faithfully.
    serde_json::to_string(&decision).expect("decision serializes");
    let label = permit.result_label();
    assert_eq!(label, &roundtrip(label));
}

#[test]
fn a_blocked_decision_and_its_violations_serialize() {
    let mut engine = PolicyEngine::new(NoAuthority, UnknownPolicy::AllowWithAudit);
    engine
        .register(ToolContract {
            name: ToolName::new("email.send"),
            requires: Requirements {
                audience: AudienceRule::RecipientsWithinContext,
                ..Requirements::default()
            },
            output_label: Label::identity(),
        })
        .unwrap();

    // No recipients on an audience-guarded sink is a structural breach.
    let decision = engine.evaluate(&Trajectory::new(), &ToolRequest::new(ToolName::new("email.send")));
    let Decision::Blocked { violations, .. } = &decision else {
        panic!("expected a blocked decision, got {decision:?}");
    };
    serde_json::to_string(&decision).expect("decision serializes");
    assert_eq!(violations, &roundtrip(violations));
}
