using System.Collections.Concurrent;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

var jsonOptions = new JsonSerializerOptions {
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
};

using var sta = new StaDispatcher();
var session = new AtolSession();
var bridge = new BridgeHost(sta, session);
var outputLock = new object();

string? line;
while ((line = Console.ReadLine()) is not null) {
    BridgeResponse response;
    try {
        var request = JsonSerializer.Deserialize<BridgeRequest>(line, jsonOptions)
            ?? throw new ProtocolException("invalid_request", "Request is empty.");
        response = await bridge.HandleAsync(request);
    } catch (ProtocolException error) {
        response = BridgeResponse.Failure(null, error.Code, error.Message);
    } catch (JsonException) {
        response = BridgeResponse.Failure(null, "invalid_json", "Request must be JSON.");
    } catch (Exception error) {
        Console.Error.WriteLine(error);
        response = BridgeResponse.Failure(null, "bridge_error", error.Message);
    }

    lock (outputLock) {
        Console.Out.WriteLine(JsonSerializer.Serialize(response, jsonOptions));
        Console.Out.Flush();
    }

    if (bridge.StopRequested) {
        break;
    }
}

internal sealed class BridgeHost(StaDispatcher dispatcher, AtolSession session) {
    public bool StopRequested { get; private set; }

    public async Task<BridgeResponse> HandleAsync(BridgeRequest request) {
        if (request.BridgeProtocol.Version != BridgeProtocol.Version) {
            return BridgeResponse.Failure(request.Id, "unsupported_protocol",
                $"Expected protocolVersion {BridgeProtocol.Version}.");
        }
        if (string.IsNullOrWhiteSpace(request.Id)) {
            return BridgeResponse.Failure(null, "invalid_request", "Request id is required.");
        }

        try {
            var result = await dispatcher.InvokeAsync(() => session.Execute(request));
            if (request.Command == "shutdown") {
                StopRequested = true;
            }
            return BridgeResponse.Success(request.Id, result);
        } catch (DriverFailure error) {
            Console.Error.WriteLine($"ATOL {error.Code}: {error.Description}");
            return BridgeResponse.Failure(request.Id, "driver_error", error.Message,
                error.Code, error.Description);
        } catch (ProtocolException error) {
            return BridgeResponse.Failure(request.Id, error.Code, error.Message);
        } catch (Exception error) {
            Console.Error.WriteLine(error);
            return BridgeResponse.Failure(request.Id, "bridge_error", error.Message);
        }
    }
}

internal sealed class AtolSession {
    private dynamic? driver;

    public object Execute(BridgeRequest request) => request.Command switch {
        "driverInfo" => DriverInfo(),
        "discover" => Discover(),
        "connect" => Connect(request.Args),
        "disconnect" => Disconnect(),
        "status" => Status(),
        "shutdown" => Shutdown(),
        _ => throw new ProtocolException("unknown_command", $"Unsupported command: {request.Command}"),
    };

    private object DriverInfo() {
        try {
            var fptr = EnsureDriver();
            return new {
                installed = true,
                version = TryProperty(fptr, "version")?.ToString(),
                architecture = "x64",
            };
        } catch (COMException error) {
            return new {
                installed = false,
                architecture = "x64",
                error = error.Message,
                code = "driver_missing",
            };
        } catch (DriverFailure error) {
            return new {
                installed = false,
                architecture = "x64",
                error = error.Message,
                code = "driver_missing",
            };
        }
    }

    private object Discover() {
        var fptr = EnsureDriver();
        try {
            fptr.setSingleSetting(Constant(fptr, "LIBFPTR_SETTING_MODEL"),
                Constant(fptr, "LIBFPTR_MODEL_ATOL_AUTO"));
            fptr.setSingleSetting(Constant(fptr, "LIBFPTR_SETTING_PORT"),
                Constant(fptr, "LIBFPTR_PORT_USB"));
            Check(fptr.open(), fptr);

            QueryStatus(fptr);
            var serialNumber = ReadParam(fptr, "LIBFPTR_PARAM_SERIAL_NUMBER")?.ToString();
            var modelName = ReadParam(fptr, "LIBFPTR_PARAM_MODEL_NAME")?.ToString();
            var firmwareVersion = ReadParam(fptr, "LIBFPTR_PARAM_UNIT_VERSION")?.ToString();
            var settingsJson = fptr.getSettings()?.ToString();

            return new[] {
                new {
                    id = $"atol:{serialNumber ?? modelName ?? "usb"}",
                    model = modelName ?? "",
                    serialNumber,
                    firmwareVersion,
                    connection = "usb",
                    settingsJson,
                },
            };
        } finally {
            Close(fptr);
        }
    }

    private object Connect(JsonElement? args) {
        var settingsJson = ArgumentString(args, "settingsJson");
        if (string.IsNullOrWhiteSpace(settingsJson)) {
            throw new ProtocolException("invalid_request", "settingsJson is required.");
        }

        var fptr = EnsureDriver();
        Close(fptr);
        fptr.setSettings(settingsJson);
        Check(fptr.open(), fptr);
        QueryStatus(fptr);

        var expectedSerial = ArgumentString(args, "expectedSerialNumber");
        var actualSerial = ReadParam(fptr, "LIBFPTR_PARAM_SERIAL_NUMBER")?.ToString();
        if (!string.IsNullOrWhiteSpace(expectedSerial) &&
            !string.Equals(expectedSerial, actualSerial, StringComparison.Ordinal)) {
            Close(fptr);
            throw new ProtocolException("serial_mismatch",
                $"Connected KKT serial {actualSerial ?? "unknown"} does not match selected device.");
        }

        return new {
            connected = true,
            serialNumber = actualSerial,
            modelName = ReadParam(fptr, "LIBFPTR_PARAM_MODEL_NAME")?.ToString(),
        };
    }

    private object Disconnect() {
        if (driver is not null) {
            Close(driver);
        }
        return new { connected = false };
    }

    private object Status() {
        var fptr = EnsureDriver();
        if (!IsOpened(fptr)) {
            return new { connected = false, errorDescription = "KKT is not connected." };
        }

        QueryStatus(fptr);
        return new {
            connected = true,
            serialNumber = ReadParam(fptr, "LIBFPTR_PARAM_SERIAL_NUMBER")?.ToString(),
            modelName = ReadParam(fptr, "LIBFPTR_PARAM_MODEL_NAME")?.ToString(),
            firmwareVersion = ReadParam(fptr, "LIBFPTR_PARAM_UNIT_VERSION")?.ToString(),
            shiftState = ReadParam(fptr, "LIBFPTR_PARAM_SHIFT_STATE"),
            paperPresent = ReadBoolParam(fptr, "LIBFPTR_PARAM_PAPER_PRESENT"),
            coverOpened = ReadBoolParam(fptr, "LIBFPTR_PARAM_COVER_OPENED"),
            printerError = ReadBoolParam(fptr, "LIBFPTR_PARAM_PRINTER_ERROR"),
            fnPresent = ReadBoolParam(fptr, "LIBFPTR_PARAM_FN_PRESENT"),
            fnError = ReadBoolParam(fptr, "LIBFPTR_PARAM_FN_ERROR"),
            fnBlocked = ReadBoolParam(fptr, "LIBFPTR_PARAM_FN_BLOCKED"),
        };
    }

    private object Shutdown() {
        if (driver is not null) {
            Close(driver);
            ReleaseDriver();
        }
        return new { stopping = true };
    }

    private dynamic EnsureDriver() {
        if (driver is not null) {
            return driver;
        }

        var type = Type.GetTypeFromProgID("AddIn.Fptr10", throwOnError: false);
        if (type is null) {
            throw new DriverFailure(null, "ATOL Driver 10 x64 COM component AddIn.Fptr10 is not registered.");
        }

        driver = Activator.CreateInstance(type)
            ?? throw new DriverFailure(null, "Could not create ATOL Driver 10 COM object.");
        return driver;
    }

    private static void QueryStatus(dynamic fptr) =>
        Check(fptr.queryData(Constant(fptr, "LIBFPTR_DT_STATUS")), fptr);

    private static object? ReadParam(dynamic fptr, string constantName) {
        try {
            var key = Constant(fptr, constantName);
            var value = fptr.getParam(key);
            return value;
        } catch {
            return null;
        }
    }

    private static bool? ReadBoolParam(dynamic fptr, string constantName) {
        var value = ReadParam(fptr, constantName);
        if (value is null) return null;
        try { return Convert.ToBoolean(value); } catch { return null; }
    }

    private static object Constant(dynamic fptr, string name) {
        try {
            return fptr.GetType().InvokeMember(name, BindingFlags.GetProperty,
                binder: null, target: fptr, args: null)
                ?? throw new MissingMemberException(name);
        } catch (Exception error) {
            throw new DriverFailure(null, $"ATOL Driver does not expose {name}: {error.Message}");
        }
    }

    private static object? TryProperty(dynamic fptr, string name) {
        try {
            return fptr.GetType().InvokeMember(name, BindingFlags.GetProperty,
                binder: null, target: fptr, args: null);
        } catch {
            return null;
        }
    }

    private static bool IsOpened(dynamic fptr) {
        try { return Convert.ToBoolean(fptr.isOpened()); } catch { return false; }
    }

    private static void Check(object? result, dynamic fptr) {
        if (result is null || Convert.ToInt32(result) != 0) {
            throw FailureFromDriver(fptr);
        }
    }

    private static DriverFailure FailureFromDriver(dynamic fptr) {
        int? code = null;
        string? description = null;
        try { code = Convert.ToInt32(fptr.errorCode()); } catch { }
        try { description = fptr.errorDescription()?.ToString(); } catch { }
        return new DriverFailure(code, description ?? "ATOL Driver operation failed.");
    }

    private static void Close(dynamic fptr) {
        try {
            if (IsOpened(fptr)) {
                fptr.close();
            }
        } catch (Exception error) {
            Console.Error.WriteLine($"ATOL close failed: {error.Message}");
        }
    }

    private void ReleaseDriver() {
        if (driver is not null && Marshal.IsComObject(driver)) {
            Marshal.FinalReleaseComObject(driver);
        }
        driver = null;
    }

    private static string? ArgumentString(JsonElement? args, string name) {
        if (args is not { ValueKind: JsonValueKind.Object } ||
            !args.Value.TryGetProperty(name, out var value) ||
            value.ValueKind == JsonValueKind.Null) {
            return null;
        }
        return value.GetString();
    }
}

internal sealed class StaDispatcher : IDisposable {
    private readonly BlockingCollection<WorkItem> queue = new();
    private readonly Thread thread;

    public StaDispatcher() {
        thread = new Thread(Run) { IsBackground = true, Name = "ATOL Driver STA" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    public Task<object> InvokeAsync(Func<object> action) {
        var completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        queue.Add(new WorkItem(action, completion));
        return completion.Task;
    }

    private void Run() {
        foreach (var work in queue.GetConsumingEnumerable()) {
            try {
                work.Completion.SetResult(work.Action());
            } catch (Exception error) {
                work.Completion.SetException(error);
            }
        }
    }

    public void Dispose() {
        queue.CompleteAdding();
        thread.Join();
        queue.Dispose();
    }

    private sealed record WorkItem(Func<object> Action, TaskCompletionSource<object> Completion);
}

internal sealed record BridgeRequest(int BridgeProtocol.Version, string? Id, string Command, JsonElement? Args);

internal sealed record BridgeResponse(
    int BridgeProtocol.Version,
    string? Id,
    bool Ok,
    object? Result,
    BridgeError? Error
) {
    public static BridgeResponse Success(string? id, object result) =>
        new(BridgeProtocol.Version, id, true, result, null);

    public static BridgeResponse Failure(string? id, string code, string message,
        int? driverErrorCode = null, string? driverErrorDescription = null) =>
        new(BridgeProtocol.Version, id, false, null,
            new BridgeError(code, message, driverErrorCode, driverErrorDescription));
}

internal sealed record BridgeError(
    string Code,
    string Message,
    int? DriverErrorCode,
    string? DriverErrorDescription
);

internal sealed class ProtocolException(string code, string message) : Exception(message) {
    public string Code { get; } = code;
}

internal sealed class DriverFailure(int? code, string description) : Exception(description) {
    public int? Code { get; } = code;
    public string Description { get; } = description;
}

internal static class BridgeProtocol {
    public const int Version = 1;
}
