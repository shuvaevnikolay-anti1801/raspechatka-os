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
        if (request.ProtocolVersion != BridgeProtocol.Version) {
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
        "recoveryProbe" => RecoveryProbe(),
        "executeJson" => ExecuteJson(request.Args),
        "shutdown" => Shutdown(),
        _ => throw new ProtocolException("unknown_command", $"Unsupported command: {request.Command}"),
    };

    private object DriverInfo() {
        try {
            var fptr = EnsureDriver();
            return new {
                installed = true,
                version = TryInvoke(fptr, "version")?.ToString(),
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
            fptr.setSingleSetting(
                Constant(fptr, "LIBFPTR_SETTING_MODEL"),
                Constant(fptr, "LIBFPTR_MODEL_ATOL_AUTO").ToString());
            fptr.setSingleSetting(
                Constant(fptr, "LIBFPTR_SETTING_PORT"),
                Constant(fptr, "LIBFPTR_PORT_USB").ToString());
            Check(fptr.applySingleSettings(), fptr);
            Check(fptr.open(), fptr);

            QueryStatus(fptr);
            var serialNumber = ReadStringParam(fptr, "LIBFPTR_PARAM_SERIAL_NUMBER");
            var modelName = ReadStringParam(fptr, "LIBFPTR_PARAM_MODEL_NAME");
            var firmwareVersion = ReadStringParam(fptr, "LIBFPTR_PARAM_UNIT_VERSION");
            var settingsJson = fptr.getSettings()?.ToString();

            if (string.IsNullOrWhiteSpace(serialNumber)) {
                throw new DriverFailure(null, "Connected ATOL KKT did not return a serial number.");
            }
            if (string.IsNullOrWhiteSpace(settingsJson)) {
                throw new DriverFailure(null, "ATOL Driver did not return connection settings.");
            }

            return new[] {
                new {
                    id = $"atol:{serialNumber}",
                    modelName = modelName ?? "",
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
        var actualSerial = ReadStringParam(fptr, "LIBFPTR_PARAM_SERIAL_NUMBER");
        if (!string.IsNullOrWhiteSpace(expectedSerial) &&
            !string.Equals(expectedSerial, actualSerial, StringComparison.Ordinal)) {
            Close(fptr);
            throw new ProtocolException("serial_mismatch",
                $"Connected KKT serial {actualSerial ?? "unknown"} does not match selected device.");
        }

        return new {
            connected = true,
            serialNumber = actualSerial,
            modelName = ReadStringParam(fptr, "LIBFPTR_PARAM_MODEL_NAME"),
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
            driverVersion = TryInvoke(fptr, "version")?.ToString(),
            serialNumber = ReadStringParam(fptr, "LIBFPTR_PARAM_SERIAL_NUMBER"),
            modelName = ReadStringParam(fptr, "LIBFPTR_PARAM_MODEL_NAME"),
            firmwareVersion = ReadStringParam(fptr, "LIBFPTR_PARAM_UNIT_VERSION"),
            shiftState = ReadShiftState(fptr),
            paperPresent = ReadBoolParam(fptr, "LIBFPTR_PARAM_RECEIPT_PAPER_PRESENT"),
            coverOpened = ReadBoolParam(fptr, "LIBFPTR_PARAM_COVER_OPENED"),
            printerConnectionLost = ReadBoolParam(fptr, "LIBFPTR_PARAM_PRINTER_CONNECTION_LOST"),
            printerError = ReadBoolParam(fptr, "LIBFPTR_PARAM_PRINTER_ERROR"),
            fnPresent = ReadBoolParam(fptr, "LIBFPTR_PARAM_FN_PRESENT"),
            invalidFn = ReadBoolParam(fptr, "LIBFPTR_PARAM_INVALID_FN"),
            deviceBlocked = ReadBoolParam(fptr, "LIBFPTR_PARAM_BLOCKED"),
        };
    }

    private object RecoveryProbe() {
        var fptr = EnsureDriver();
        if (!IsOpened(fptr)) {
            throw new ProtocolException("not_connected", "Connect the selected KKT before recoveryProbe.");
        }
        QueryStatus(fptr);
        var serialNumber = ReadStringParam(fptr, "LIBFPTR_PARAM_SERIAL_NUMBER");
        var statusShiftNumber = ReadIntParam(fptr, "LIBFPTR_PARAM_SHIFT_NUMBER");
        bool? documentClosed = null;
        try {
            var result = fptr.checkDocumentClosed();
            if (Convert.ToInt32(result) == 0) {
                documentClosed = ReadBoolParam(fptr, "LIBFPTR_PARAM_DOCUMENT_CLOSED");
            }
        } catch (Exception error) {
            Console.Error.WriteLine($"ATOL checkDocumentClosed unavailable: {error.Message}");
        }

        var lastReceiptType = TryConstant(fptr, "LIBFPTR_FNDT_LAST_RECEIPT");
        var lastDocumentType = TryConstant(fptr, "LIBFPTR_FNDT_LAST_DOCUMENT");
        if (lastReceiptType is null && lastDocumentType is null) {
            throw new DriverFailure(null,
                "ATOL Driver exposes neither LIBFPTR_FNDT_LAST_RECEIPT nor LIBFPTR_FNDT_LAST_DOCUMENT.");
        }

        var usedLastReceipt = false;
        DriverFailure? lastQueryError = null;
        if (lastReceiptType is not null) {
            try {
                QueryFnData(fptr, lastReceiptType);
                usedLastReceipt = true;
            } catch (DriverFailure error) {
                lastQueryError = error;
                Console.Error.WriteLine($"ATOL LAST_RECEIPT unavailable, trying LAST_DOCUMENT: {error.Message}");
            }
        }
        if (!usedLastReceipt) {
            if (lastDocumentType is null) throw lastQueryError ?? new DriverFailure(null, "ATOL FN recovery query is unavailable.");
            QueryFnData(fptr, lastDocumentType);
        }

        var receiptType = usedLastReceipt
            ? ReadIntParam(fptr, "LIBFPTR_PARAM_RECEIPT_TYPE")
            : null;
        var receiptSum = usedLastReceipt
            ? ReadPositiveDoubleParam(fptr, "LIBFPTR_PARAM_RECEIPT_SUM")
                ?? ReadPositiveDoubleParam(fptr, "LIBFPTR_PARAM_SUM")
            : null;
        return new {
            kktSerialNumber = serialNumber,
            shiftNumber = ReadIntParam(fptr, "LIBFPTR_PARAM_SHIFT_NUMBER") ?? statusShiftNumber,
            fiscalDocumentNumber = ReadIntParam(fptr, "LIBFPTR_PARAM_DOCUMENT_NUMBER"),
            fiscalSign = ReadStringParam(fptr, "LIBFPTR_PARAM_FISCAL_SIGN")
                ?? ReadIntParam(fptr, "LIBFPTR_PARAM_FISCAL_SIGN")?.ToString(),
            kktDateTime = ReadDateTimeParam(fptr, "LIBFPTR_PARAM_DATE_TIME"),
            documentClosed,
            receiptKind = ReceiptKind(fptr, receiptType),
            amount = receiptSum,
        };
    }

    private object ExecuteJson(JsonElement? args) {
        var json = ArgumentString(args, "json");
        if (string.IsNullOrWhiteSpace(json)) {
            throw new ProtocolException("invalid_request", "json is required.");
        }
        try {
            using var parsed = JsonDocument.Parse(json);
            if (parsed.RootElement.ValueKind != JsonValueKind.Object) {
                throw new ProtocolException("invalid_request", "json must be a JSON object.");
            }
        } catch (JsonException) {
            throw new ProtocolException("invalid_request", "json must be a JSON object.");
        }

        var fptr = EnsureDriver();
        if (!IsOpened(fptr)) {
            throw new ProtocolException("not_connected", "Connect the selected KKT before executeJson.");
        }
        fptr.setParam(Constant(fptr, "LIBFPTR_PARAM_JSON_DATA"), json);
        Check(fptr.processJson(), fptr);
        var responseJson = fptr.getParamString(
            Constant(fptr, "LIBFPTR_PARAM_JSON_DATA"))?.ToString();
        if (string.IsNullOrWhiteSpace(responseJson)) {
            throw new DriverFailure(null, "ATOL Driver returned an empty JSON response.");
        }
        try {
            using var response = JsonDocument.Parse(responseJson);
            return response.RootElement.Clone();
        } catch (JsonException error) {
            throw new DriverFailure(null, $"ATOL Driver returned invalid JSON: {error.Message}");
        }
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

    private static void QueryStatus(dynamic fptr) {
        fptr.setParam(
            Constant(fptr, "LIBFPTR_PARAM_DATA_TYPE"),
            Constant(fptr, "LIBFPTR_DT_STATUS"));
        Check(fptr.queryData(), fptr);
    }

    private static void QueryFnData(dynamic fptr, object fnDataType) {
        fptr.setParam(Constant(fptr, "LIBFPTR_PARAM_FN_DATA_TYPE"), fnDataType);
        Check(fptr.fnQueryData(), fptr);
    }

    private static double? ReadPositiveDoubleParam(dynamic fptr, string constantName) {
        var value = ReadDoubleParam(fptr, constantName);
        return value is > 0 ? value : null;
    }

    private static string? ReadStringParam(dynamic fptr, string constantName) {
        try {
            return fptr.getParamString(Constant(fptr, constantName))?.ToString();
        } catch {
            return null;
        }
    }

    private static long? ReadIntParam(dynamic fptr, string constantName) {
        try {
            return Convert.ToInt64(fptr.getParamInt(Constant(fptr, constantName)));
        } catch {
            return null;
        }
    }

    private static string? ReadShiftState(dynamic fptr) {
        var state = ReadIntParam(fptr, "LIBFPTR_PARAM_SHIFT_STATE");
        if (state is null) return null;
        try {
            if (state == Convert.ToInt64(Constant(fptr, "LIBFPTR_SS_CLOSED"))) return "closed";
            if (state == Convert.ToInt64(Constant(fptr, "LIBFPTR_SS_OPENED"))) return "opened";
            if (state == Convert.ToInt64(Constant(fptr, "LIBFPTR_SS_EXPIRED"))) return "expired";
        } catch { }
        return state.Value.ToString();
    }

    private static double? ReadDoubleParam(dynamic fptr, string constantName) {
        try {
            return Convert.ToDouble(fptr.getParamDouble(Constant(fptr, constantName)));
        } catch {
            return null;
        }
    }

    private static string? ReadDateTimeParam(dynamic fptr, string constantName) {
        try {
            var value = fptr.getParamDateTime(Constant(fptr, constantName));
            return value is DateTime dateTime
                ? dateTime.ToString("O")
                : value?.ToString();
        } catch {
            return null;
        }
    }

    private static bool? ReadBoolParam(dynamic fptr, string constantName) {
        try {
            return Convert.ToBoolean(fptr.getParamBool(Constant(fptr, constantName)));
        } catch {
            return null;
        }
    }

    private static string? ReceiptKind(dynamic fptr, long? receiptType) {
        if (receiptType is null) return null;
        var sell = TryConstant(fptr, "LIBFPTR_RT_SELL");
        if (sell is not null && receiptType == Convert.ToInt64(sell)) return "sale";
        var sellReturn = TryConstant(fptr, "LIBFPTR_RT_SELL_RETURN");
        if (sellReturn is not null && receiptType == Convert.ToInt64(sellReturn)) return "return";
        return null;
    }

    private static object? TryConstant(dynamic fptr, string name) {
        try {
            return fptr.GetType().InvokeMember(name, BindingFlags.GetProperty,
                binder: null, target: fptr, args: null);
        } catch {
            return null;
        }
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

    private static object? TryInvoke(dynamic fptr, string name) {
        try {
            return fptr.GetType().InvokeMember(name, BindingFlags.InvokeMethod,
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

internal sealed record BridgeRequest(int ProtocolVersion, string? Id, string Command, JsonElement? Args);

internal sealed record BridgeResponse(
    int ProtocolVersion,
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
