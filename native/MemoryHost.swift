import Foundation
import Darwin

// Native messaging uses a UInt32 length in native byte order. Both supported
// macOS architectures (arm64 and x86_64) are little-endian.
private let maximumRequestBytes = 16 * 1024
private let maximumResponseBytes = 1024 * 1024
private let pressureSysctl = "kern.memorystatus_vm_pressure_level"

private struct HostFailure: Error, CustomStringConvertible {
    let code: String
    let message: String

    var description: String { "\(code): \(message)" }
}

private func ioFailure(_ operation: String, _ error: Int32) -> HostFailure {
    HostFailure(code: "io_error", message: "\(operation): \(String(cString: strerror(error)))")
}

// Only a clean EOF before a new header is a normal shutdown. A partial header
// or body is a truncated frame, not an empty request.
private func readFully(
    into buffer: UnsafeMutableRawPointer,
    count: Int,
    allowCleanEOF: Bool = false
) throws -> Bool {
    var received = 0
    while received < count {
        let amount = Darwin.read(STDIN_FILENO, buffer.advanced(by: received), count - received)
        if amount > 0 {
            received += amount
        } else if amount == 0 {
            if received == 0 && allowCleanEOF { return false }
            throw HostFailure(
                code: "truncated_frame",
                message: "Expected \(count) bytes, received \(received) before EOF."
            )
        } else {
            let error = errno
            if error == EINTR { continue }
            throw ioFailure("read", error)
        }
    }
    return true
}

private func writeFully(_ buffer: UnsafeRawPointer, count: Int, descriptor: Int32) throws {
    var sent = 0
    while sent < count {
        let amount = Darwin.write(descriptor, buffer.advanced(by: sent), count - sent)
        if amount > 0 {
            sent += amount
        } else if amount < 0 {
            let error = errno
            if error == EINTR { continue }
            throw ioFailure("write", error)
        } else {
            throw HostFailure(code: "io_error", message: "write made no progress.")
        }
    }
}

private func readFrame() throws -> Data? {
    var header: UInt32 = 0
    let hasHeader = try withUnsafeMutableBytes(of: &header) { bytes in
        try readFully(into: bytes.baseAddress!, count: bytes.count, allowCleanEOF: true)
    }
    if !hasHeader { return nil }

    let length = Int(UInt32(littleEndian: header))
    guard length > 0 && length <= maximumRequestBytes else {
        // Do not allocate or try to drain an untrusted, oversized frame.
        throw HostFailure(code: "invalid_length", message: "Request length must be 1...\(maximumRequestBytes) bytes.")
    }
    var data = Data(count: length)
    try data.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
        _ = try readFully(into: bytes.baseAddress!, count: length)
    }
    return data
}

private func writeFrame(_ response: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: response)
    guard !data.isEmpty && data.count <= maximumResponseBytes else {
        throw HostFailure(code: "invalid_response_length", message: "Response exceeds the native messaging limit.")
    }
    var header = UInt32(data.count).littleEndian
    try withUnsafeBytes(of: &header) { bytes in
        try writeFully(bytes.baseAddress!, count: bytes.count, descriptor: STDOUT_FILENO)
    }
    try data.withUnsafeBytes { bytes in
        try writeFully(bytes.baseAddress!, count: bytes.count, descriptor: STDOUT_FILENO)
    }
}

private func pressureReading() throws -> [String: Any] {
    var rawLevel: UInt32 = 0
    var size = MemoryLayout<UInt32>.size
    guard sysctlbyname(pressureSysctl, &rawLevel, &size, nil, 0) == 0 else {
        let error = errno
        throw HostFailure(
            code: "pressure_unavailable",
            message: "\(pressureSysctl): \(String(cString: strerror(error))). This helper requires macOS with this read-only sysctl."
        )
    }
    guard size == MemoryLayout<UInt32>.size else {
        throw HostFailure(code: "invalid_pressure_size", message: "Unexpected pressure sysctl value size: \(size).")
    }

    // XNU converts its *internal* 0/1/2/3 pressure enum to these userspace
    // NOTE_MEMORYSTATUS_PRESSURE_* flags before SYSCTL_OUT. Do not map the
    // internal enum here: a sysctl result of 1 means normal, not warning.
    // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c
    let level: String
    switch rawLevel {
    case 1: level = "normal"
    case 2: level = "warning"
    case 4: level = "critical"
    default:
        throw HostFailure(code: "unknown_pressure_level", message: "Unrecognized pressure sysctl flag: \(rawLevel).")
    }
    return [
        "level": level,
        "rawLevel": rawLevel,
        "at": Int64(Date().timeIntervalSince1970 * 1000)
    ]
}

private func reply(to data: Data) -> [String: Any] {
    do {
        // Foundation also accepts UTF-16/32 JSON. Those encodings contain NUL
        // bytes for the required ASCII action/key, while native messages must
        // be UTF-8. Reject them without allocating a second decoded string.
        guard !data.contains(0) else {
            throw HostFailure(code: "invalid_json", message: "The request must be a UTF-8 JSON object.")
        }
        guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              request.count == 1,
              let action = request["action"] as? String,
              action == "memory" else {
            throw HostFailure(
                code: "invalid_request",
                message: "Expected exactly {\"action\":\"memory\"}; this helper accepts no URLs or other payloads."
            )
        }
        return try pressureReading()
    } catch let failure as HostFailure {
        return ["error": ["code": failure.code, "message": failure.message]]
    } catch {
        return ["error": ["code": "invalid_json", "message": "The request must be a UTF-8 JSON object."]]
    }
}

private func diagnose(_ message: String) {
    let line = "com.sheeki.tab_memory: \(message)\n"
    line.withCString { bytes in
        // Diagnostics never go to stdout; a closed stderr must not recurse.
        try? writeFully(UnsafeRawPointer(bytes), count: strlen(bytes), descriptor: STDERR_FILENO)
    }
}

signal(SIGPIPE, SIG_IGN)

do {
    while true {
        // A long-lived connectNative port must not retain Foundation's
        // autoreleased JSON objects across successive one-minute checks.
        let didRead = try autoreleasepool { () throws -> Bool in
            guard let data = try readFrame() else { return false }
            try writeFrame(reply(to: data))
            return true
        }
        if !didRead { break }
    }
} catch {
    diagnose(String(describing: error))
    exit(EXIT_FAILURE)
}
