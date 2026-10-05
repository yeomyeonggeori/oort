//! ADR-0197 M4 (증보 2): the registration proof the runner verifies. The server relays it and cannot check it.

use momo_blind_pty::trust::{registration_mac, verify_registration_mac};

const BOX: [u8; 16] = [7; 16];
const HOST: [u8; 32] = [9; 32];

#[test]
fn only_the_holder_of_the_code_can_make_a_mac_for_this_box_and_key() {
    let code = [3u8; 32];
    let mac = registration_mac(&code, &BOX, &HOST);
    assert!(verify_registration_mac(&code, &BOX, &HOST, &mac));
    // Another code (a server guessing), another box, another key, a truncated or flipped mac.
    assert!(!verify_registration_mac(&[4u8; 32], &BOX, &HOST, &mac));
    assert!(!verify_registration_mac(&code, &[8u8; 16], &HOST, &mac));
    assert!(!verify_registration_mac(&code, &BOX, &[1u8; 32], &mac));
    assert!(!verify_registration_mac(&code, &BOX, &HOST, &mac[..31]));
    let mut flipped = mac;
    flipped[0] ^= 1;
    assert!(!verify_registration_mac(&code, &BOX, &HOST, &flipped));
}

#[test]
fn the_mac_is_a_function_of_the_label_box_and_key_only() {
    let code = [3u8; 32];
    assert_eq!(
        registration_mac(&code, &BOX, &HOST),
        registration_mac(&code, &BOX, &HOST)
    );
    assert_ne!(
        registration_mac(&code, &BOX, &HOST),
        registration_mac(&code, &BOX, &[10u8; 32])
    );
}

#[test]
fn a_host_pin_roundtrips_through_its_wire_form_and_rejects_garbage() {
    use momo_blind_pty::trust::HostPin;
    let pin = HostPin {
        box_id: [1; 16],
        host_pub: [2; 32],
        runner_pub: [3; 32],
        attestation: [4; 64],
        signer_dev: [5; 33],
        sig_owner: [6; 64],
    };
    let bytes = pin.to_bytes();
    assert_eq!(bytes.len(), HostPin::WIRE_LEN);
    assert_eq!(HostPin::from_bytes(&bytes).unwrap(), pin);
    assert!(HostPin::from_bytes(&bytes[1..]).is_err());
    let mut longer = bytes.clone();
    longer.push(0);
    assert!(HostPin::from_bytes(&longer).is_err());
    assert!(HostPin::from_bytes(&[]).is_err());
}
