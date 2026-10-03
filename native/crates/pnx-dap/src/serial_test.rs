use std::{io::{Read, Write}, thread, time::Duration};

const USART_HOST_MAGIC: u32 = 0x3153_5544;
const USART_DEVICE_MAGIC: u32 = 0x3153_5552;
const USB_HOST_MAGIC: u32 = 0x3142_5344;
const USB_DEVICE_MAGIC: u32 = 0x3142_5352;
const CHECKSUM_SEED: u32 = 0xA5A5_1234;
const DEVICE_PACKET_LEN: usize = 32;

fn argument<'a>(args: &'a [String], name: &str) -> Result<&'a str, String> {
    let index = args.iter().position(|item| item == name).ok_or_else(|| format!("{name} is required"))?;
    args.get(index + 1).map(String::as_str).ok_or_else(|| format!("{name} requires a value"))
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.iter().fold(CHECKSUM_SEED, |value, byte| (value << 5) ^ (value >> 2) ^ u32::from(*byte))
}

fn host_packet(seq: u32, value: f32, flag: bool, usb: bool) -> [u8; 24] {
    let mut packet = [0_u8; 24];
    packet[0..4].copy_from_slice(&(if usb { USB_HOST_MAGIC } else { USART_HOST_MAGIC }).to_le_bytes());
    packet[4..8].copy_from_slice(&seq.to_le_bytes());
    packet[8..12].copy_from_slice(&value.to_le_bytes());
    packet[12] = u8::from(flag);
    packet[16..20].copy_from_slice(&(seq * (if usb { 5 } else { 3 })).to_le_bytes());
    let digest = checksum(&packet[..20]);
    packet[20..24].copy_from_slice(&digest.to_le_bytes());
    packet
}

fn read_u32(bytes: &[u8], start: usize) -> u32 {
    u32::from_le_bytes(bytes[start..start + 4].try_into().unwrap())
}

fn validate_response(packet: &[u8; DEVICE_PACKET_LEN], seq: u32, value: f32, flag: bool, usb: bool) -> Result<(u32, u32, u32), String> {
    if read_u32(packet, 28) != checksum(&packet[..28]) { return Err(format!("bad response checksum at seq={seq}")); }
    if read_u32(packet, 0) != (if usb { USB_DEVICE_MAGIC } else { USART_DEVICE_MAGIC }) { return Err(format!("unexpected response magic at seq={seq}")); }
    if read_u32(packet, 4) != seq { return Err(format!("response sequence mismatch at seq={seq}")); }
    if packet[8] != 0 || packet[9] == 0 { return Err(format!("device status={} ready={} at seq={seq}", packet[8], packet[9])); }
    let received = f32::from_le_bytes(packet[12..16].try_into().unwrap());
    if (packet[10] != 0) != flag || !received.is_finite() || (received - value).abs() > 0.001 {
        return Err(format!("payload mismatch at seq={seq}"));
    }
    Ok((read_u32(packet, 16), read_u32(packet, 20), read_u32(packet, 24)))
}

pub fn run(args: &[String]) -> Result<(), String> {
    let protocol = if args.iter().any(|arg| arg == "--protocol") { argument(args, "--protocol")? } else { "usart" };
    if protocol != "usart" && protocol != "usb" { return Err("protocol must be usart or usb".into()); }
    let usb = protocol == "usb";
    let port = argument(args, "--port")?;
    let baud = argument(args, "--baud")?.parse::<u32>().map_err(|_| "invalid baud rate")?;
    if !(1200..=3_000_000).contains(&baud) { return Err("baud rate must be 1200..3000000".into()); }
    let count = args.iter().position(|item| item == "--count")
        .map(|index| args.get(index + 1).ok_or("--count requires a value")?.parse::<u32>().map_err(|_| "invalid count"))
        .transpose()?.unwrap_or(10);
    if count == 0 || count > 1000 { return Err("count must be 1..1000".into()); }
    let mut serial = serialport::new(port, baud).timeout(Duration::from_secs(1)).open()
        .map_err(|error| format!("cannot open {port}: {error}"))?;
    serial.clear(serialport::ClearBuffer::All).map_err(|error| format!("cannot clear {port}: {error}"))?;
    for seq in 1..=count {
        let value = if usb { 20.0 + seq as f32 * 0.25 } else { 10.0 + seq as f32 * 0.5 };
        let flag = (seq % 2 == 0) == usb;
        serial.write_all(&host_packet(seq, value, flag, usb)).map_err(|error| format!("write seq={seq}: {error}"))?;
        serial.flush().map_err(|error| format!("flush seq={seq}: {error}"))?;
        let mut response = [0_u8; DEVICE_PACKET_LEN];
        serial.read_exact(&mut response).map_err(|error| format!("read seq={seq}: {error}"))?;
        let (rx, tx, errors) = validate_response(&response, seq, value, flag, usb)?;
        println!("PASS {} seq={seq} rx={rx} tx={tx} err={errors}", protocol.to_uppercase());
        thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_packet_matches_the_firmware_wire_layout() {
        let packet = host_packet(7, 1.25, true, false);
        assert_eq!(read_u32(&packet, 0), USART_HOST_MAGIC);
        assert_eq!(read_u32(&packet, 4), 7);
        assert_eq!(packet[12], 1);
        assert_eq!(read_u32(&packet, 16), 21);
        assert_eq!(read_u32(&packet, 20), checksum(&packet[..20]));
        let usb_packet = host_packet(7, 1.25, true, true);
        assert_eq!(read_u32(&usb_packet, 0), USB_HOST_MAGIC);
        assert_eq!(read_u32(&usb_packet, 16), 35);
    }

    #[test]
    fn rejects_corrupt_response_before_accepting_values() {
        let mut packet = [0_u8; DEVICE_PACKET_LEN];
        packet[0..4].copy_from_slice(&USART_DEVICE_MAGIC.to_le_bytes());
        packet[4..8].copy_from_slice(&1_u32.to_le_bytes());
        packet[9] = 1;
        packet[10] = 1;
        packet[12..16].copy_from_slice(&10.5_f32.to_le_bytes());
        let digest = checksum(&packet[..28]);
        packet[28..32].copy_from_slice(&digest.to_le_bytes());
        assert!(validate_response(&packet, 1, 10.5, true, false).is_ok());
        packet[12] ^= 0x01;
        assert!(validate_response(&packet, 1, 10.5, true, false).is_err());
    }
}
