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
        if (request.ProtocolVersion is null) {
            return BridgeResponse.Failure(request.Id, "invalid_request",
                "protocolVersion is required.");
        }
        if (request.ProtocolVersion != BridgeProtocol.Version) {
            return BridgeResponse.Failure(request.Id, "unsupported_protocol",
                $"Expected protocolVersion {BridgeProtocol.Version}.");
        }
        if (string.IsNullOrWhiteSpace(request.Id)) {
            return BridgeResponse.Failure(null, "invalid_request", "Request id is required.");
        }

        try {
            var timeout = TimeoutFor(request.Command);
            var operation = dispatcher.InvokeAsync(request.Command, () => session.Execute(request));
            if (timeout is not null && !operation.IsCompleted) {
                var completed = await Task.WhenAny(operation, Task.Delay(timeout.Value));
                if (completed != operation) {
                    var stage = session.CurrentStage ?? request.Command;
                    Console.Error.WriteLine(
                        $"[ATOL] {request.Command} timed out at stage {stage} after {timeout.Value.TotalMilliseconds:0} ms");
                    // A blocked in-proc COM call cannot be cancelled safely. Return a bounded
                    // response, then terminate this helper so the next request gets a fresh STA.
                    StopRequested = true;
                    if (request.Command == "diagnostics") {
                        return BridgeResponse.Success(request.Id, session.DiagnosticsTimeoutResult(stage));
                    }
                    return BridgeResponse.Failure(request.Id, "driver_timeout",
                        "ATOL Driver operation exceeded timeout", stage: stage);
                }
            }
            var result = await operation;
            if (request.Command == "shutdown") {
                StopRequested = true;
            }
            return BridgeResponse.Success(request.Id, result);
        } catch (DriverFailure error) {
            Console.Error.WriteLine($"ATOL {error.Code}: {error.Description}");
            return BridgeResponse.Failure(request.Id, error.OperationCode ?? "driver_error", error.Message,
                error.Code, error.Description, error.Stage);
        } catch (ProtocolException error) {
            return BridgeResponse.Failure(request.Id, error.Code, error.Message);
        } catch (Exception error) {
            Console.Error.WriteLine(error);
            return BridgeResponse.Failure(request.Id, "bridge_error", error.Message);
        }
    }

    private static TimeSpan? TimeoutFor(string command) => command switch {
        // Keep the native timeout below the TypeScript transport timeout so the
        // bridge can return a stage-aware error before the parent kills it.
        "driverInfo" or "diagnostics" or "discover" or "connect" or "disconnect" or "status" or "recoveryProbe"
            => TimeSpan.FromSeconds(8),
        "executeJson" or "reprintDocument" => TimeSpan.FromSeconds(55),
        _ => null,
    };
}

internal sealed class AtolSession {
    private dynamic? driver;
    private volatile string? currentStage;
    private volatile bool diagnosticRegistered;
    private volatile bool diagnosticComCreated;

    public string? CurrentStage => currentStage;

    public object Execute(BridgeRequest request) {
        currentStage = request.Command;
        return request.Command switch {
            "driverInfo" => DriverInfo(),
            "diagnostics" => Diagnostics(),
            "discover" => Discover(),
            "connect" => Connect(request.Args),
            "disconnect" => Disconnect(),
            "status" => Status(),
            "recoveryProbe" => RecoveryProbe(),
            "executeJson" => ExecuteJson(request.Args),
            "shutdown" => Shutdown(),
            _ => throw new ProtocolException("unknown_command", $"Unsupported command: {request.Command}"),
        };
    }

    public object DiagnosticsTimeoutResult(string stage) {
        var steps = new List<object>();
        if (stage == "com_lookup" && !diagnosticRegistered) {
            steps.Add(new { name = "GetTypeFromProgID", success = false, error = "timeout" });
        } else {
            steps.Add(new { name = "GetTypeFromProgID", success = diagnosticRegistered,
                error = diagnosticRegistered ? null : "not_registered" });
        }

        if (diagnosticRegistered) {
            steps.Add(new { name = "CreateInstance", success = diagnosticComCreated,
                error = diagnosticComCreated ? null : (stage == "com_create" ? "timeout" : "create_failed") });
        }
        if (diagnosticComCreated) {
            steps.Add(new { name = "DriverCall", success = false, error = "timeout" });
        }

        return new {
            progIdRegistered = diagnosticRegistered,
            comCreated = diagnosticComCreated,
            driverResponded = false,
            stage,
            steps,
        };
    }

    private void StageStarted(string stage, string label) {
        currentStage = stage;
        Console.Error.WriteLine($"[ATOL] {label} started");
    }

    private static void StageFinished(string label) {
        Console.Error.WriteLine($"[ATOL] {label} finished");
    }

    private object DriverInfo() {
        var registered = false;
        try {
            StageStarted("com_lookup", "COM lookup");
            var type = Type.GetTypeFromProgID("AddIn.Fptr10", throwOnError: false);
            StageFinished("COM lookup");
            if (type is null) {
                return new { installed = false, comCreated = false, architecture = "x64", code = "driver_missing" };
            }

            registered = true;
            Console.Error.WriteLine("[ATOL] COM class found");
            StageStarted("com_create", "COM object creation");
            var fptr = EnsureDriver(type);
            StageFinished("COM object creation");
            // Intentionally do not call version/open/queryData/status here. DriverInfo
            // only proves registration + COM activation and therefore stays bounded.
            return new { installed = true, comCreated = fptr is not null, architecture = "x64" };
        } catch (DriverFailure error) {
            return new { installed = registered, comCreated = false, architecture = "x64", error = error.Message,
                code = error.OperationCode ?? (registered ? "com_create_failed" : "com_lookup_failed"),
                stage = error.Stage ?? CurrentStage };
        } catch (Exception error) {
            return new { installed = registered, comCreated = false, architecture = "x64", error = error.Message,
                code = registered ? "com_create_failed" : "com_lookup_failed", stage = CurrentStage };
        }
    }

    private object Diagnostics() {
        diagnosticRegistered = false;
        diagnosticComCreated = false;
        var steps = new List<object>();
        Console.Error.WriteLine("[ATOL] diagnostics started");

        StageStarted("com_lookup", "COM lookup");
        var type = Type.GetTypeFromProgID("AddIn.Fptr10", throwOnError: false);
        diagnosticRegistered = type is not null;
        StageFinished("COM lookup");
        steps.Add(new { name = "GetTypeFromProgID", success = diagnosticRegistered,
            error = diagnosticRegistered ? null : "not_registered" });
        if (!diagnosticRegistered) {
            return new { progIdRegistered = false, comCreated = false, driverResponded = false, steps };
        }

        dynamic fptr;
        try {
            StageStarted("com_create", "COM object creation");
            fptr = EnsureDriver(type!);
            diagnosticComCreated = true;
            StageFinished("COM object creation");
            steps.Add(new { name = "CreateInstance", success = true, error = (string?)null });
        } catch (Exception error) {
            steps.Add(new { name = "CreateInstance", success = false, error = error.Message });
            return new { progIdRegistered = true, comCreated = false, driverResponded = false, steps };
        }

        StageStarted("driver_call", "DriverCall");
        var value = TryInvoke(fptr, "version");
        var responded = value is not null;
        StageFinished("DriverCall");
        steps.Add(new { name = "DriverCall", success = responded,
            error = responded ? null : "driver_error" });
        return new { progIdRegistered = true, comCreated = true, driverResponded = responded, steps };
    }

    private object Discover() {
        StageStarted("com_create", "COM object creation");
        dynamic fptr;
        try {
            fptr = EnsureDriver();
            StageFinished("COM object creation");
        } catch (Exception error) {
            throw StageFailure("com_create", "com_create_failed", error);
        }
        try {
            StageStarted("configure", "configure USB auto");
            try {
                fptr.setSingleSetting(
                    Constant(fptr, "LIBFPTR_SETTING_MODEL"),
                    Constant(fptr, "LIBFPTR_MODEL_ATOL_AUTO").ToString());
                fptr.setSingleSetting(
                    Constant(fptr, "LIBFPTR_SETTING_PORT"),
                    Constant(fptr, "LIBFPTR_PORT_USB").ToString());
                Check(fptr.applySingleSettings(), fptr);
                StageFinished("configure USB auto");
            } catch (Exception error) {
                throw StageFailure("configure", "configure_failed", error);
            }

            StageStarted("open", "open");
            try {
                Check(fptr.open(), fptr);
                StageFinished("open");
            } catch (Exception error) {
                throw StageFailure("open", "open_failed", error);
            }

            StageStarted("query", "query status");
            try {
                QueryStatus(fptr);
                StageFinished("query status");
            } catch (Exception error) {
                throw StageFailure("query", "query_failed", error);
            }

            StageStarted("read", "read KKT parameters");
            try {
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
                var result = new[] {
                    new {
                        id = $"atol:{serialNumber}",
                        modelName = modelName ?? "",
                        serialNumber,
                        firmwareVersion,
                        connection = "usb",
                        settingsJson,
                    },
                };
                StageFinished("read KKT parameters");
                return result;
            } catch (Exception error) {
                throw StageFailure("read", "read_failed", error);
            }
        } finally {
            StageStarted("close", "close");
            Close(fptr);
            StageFinished("close");
        }
    }

    private static DriverFailure StageFailure(string stage, string code, Exception error) {
        var summary = code switch {
            "com_create_failed" => "ATOL Driver COM object creation failed",
            "configure_failed" => "ATOL KKT configuration failed",
            "open_failed" => "ATOL KKT open failed",
            "query_failed" => "ATOL KKT status query failed",
            "read_failed" => "ATOL KKT parameter read failed",
            _ => "ATOL Driver operation failed",
        };
        return error is DriverFailure driverError
            ? new DriverFailure(driverError.Code, $"{summary}: {driverError.Description}",
                driverError.OperationCode ?? code, driverError.Stage ?? stage)
            : new DriverFailure(null, $"{summary}: {error.Message}", code, stage);
    }

    private object Connect(JsonElement? args) {
        var settingsJson = ArgumentString(args, "settingsJson");
        if (string.IsNullOrWhiteSpace(settingsJson)) {
            throw new ProtocolException("invalid_request", "settingsJson is required.");
        }

        StageStarted("com_create", "COM object creation");
        dynamic fptr;
        try {
            fptr = EnsureDriver();
            StageFinished("COM object creation");
        } catch (Exception error) {
            throw StageFailure("com_create", "com_create_failed", error);
        }

        StageStarted("close", "close existing connection");
        Close(fptr);
        StageFinished("close existing connection");

        StageStarted("configure", "apply saved settings");
        try {
            fptr.setSettings(settingsJson);
            StageFinished("apply saved settings");
        } catch (Exception error) {
            throw StageFailure("configure", "configure_failed", error);
        }

        StageStarted("open", "open");
        try {
            Check(fptr.open(), fptr);
            StageFinished("open");
        } catch (Exception error) {
            throw StageFailure("open", "open_failed", error);
        }

        StageStarted("query", "query status");
        try {
            QueryStatus(fptr);
            StageFinished("query status");
        } catch (Exception error) {
            throw StageFailure("query", "query_failed", error);
        }

        StageStarted("read", "read selected KKT");
        var expectedSerial = ArgumentString(args, "expectedSerialNumber");
        var actualSerial = ReadStringParam(fptr, "LIBFPTR_PARAM_SERIAL_NUMBER");
        if (!string.IsNullOrWhiteSpace(expectedSerial) &&
            !string.Equals(expectedSerial, actualSerial, StringComparison.Ordinal)) {
            Close(fptr);
            throw new ProtocolException("serial_mismatch",
                $"Connected KKT serial {actualSerial ?? "unknown"} does not match selected device.");
        }

        var modelName = ReadStringParam(fptr, "LIBFPTR_PARAM_MODEL_NAME");
        StageFinished("read selected KKT");
        return new {
            connected = true,
            serialNumber = actualSerial,
            modelName,
        };
    }

    private object Disconnect() {
        if (driver is not null) {
            StageStarted("close", "close");
            Close(driver);
            StageFinished("close");
        }
        return new { connected = false };
    }

    private object Status() {
        StageStarted("com_create", "COM object creation");
        dynamic fptr;
        try {
            fptr = EnsureDriver();
            StageFinished("COM object creation");
        } catch (Exception error) {
            throw StageFailure("com_create", "com_create_failed", error);
        }

        StageStarted("open_state", "read open state");
        var opened = IsOpened(fptr);
        StageFinished("read open state");
        if (!opened) {
            return new { connected = false, errorDescription = "KKT is not connected." };
        }

        StageStarted("query", "query status");
        QueryStatus(fptr);
        StageFinished("query status");

        StageStarted("read", "read status parameters");
        var result = new {
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
        StageFinished("read status parameters");
        return result;
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

    private object ReprintDocument(JsonElement? args) {
        var rawDocumentNumber = ArgumentString(args, "documentNumber");
        if (string.IsNullOrWhiteSpace(rawDocumentNumber) ||
            !long.TryParse(rawDocumentNumber, out var documentNumber) ||
            documentNumber <= 0) {
            throw new ProtocolException("invalid_request", "documentNumber must be a positive fiscal document number.");
        }

        var fptr = EnsureDriver();
        if (!IsOpened(fptr)) {
            throw new ProtocolException("not_connected", "Connect the selected KKT before reprintDocument.");
        }
        QueryStatus(fptr);

        var reportTypeParam = TryConstant(fptr, "LIBFPTR_PARAM_REPORT_TYPE");
        var documentNumberParam = TryConstant(fptr, "LIBFPTR_PARAM_DOCUMENT_NUMBER");
        var fnDocumentReport = TryConstant(fptr, "LIBFPTR_RT_FN_DOC_BY_NUMBER");
        if (reportTypeParam is null || documentNumberParam is null || fnDocumentReport is null) {
            throw new ProtocolException(
                "not_supported",
                "Installed ATOL Driver does not expose exact FN document printing by number."
            );
        }

        try {
            fptr.setParam(reportTypeParam, fnDocumentReport);
            fptr.setParam(documentNumberParam, documentNumber);
            Check(fptr.report(), fptr);
        } catch (DriverFailure) {
            throw;
        } catch (Exception error) {
            throw new DriverFailure(
                null,
                $"ATOL exact fiscal document print is unavailable: {error.Message}"
            );
        }

        return new {
            documentNumber,
            printed = true,
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
        var type = Type.GetTypeFromProgID("AddIn.Fptr10", throwOnError: false);
        if (type is null) {
            throw new DriverFailure(null, "ATOL Driver 10 x64 COM component AddIn.Fptr10 is not registered.", "driver_missing", "com_lookup");
        }
        return EnsureDriver(type);
    }

    private dynamic EnsureDriver(Type type) {
        if (driver is not null) return driver;
        Console.Error.WriteLine("[ATOL] COM object creation started");
        driver = Activator.CreateInstance(type)
            ?? throw new DriverFailure(null, "Could not create ATOL Driver 10 COM object.", "com_create_failed", "com_create");
        Console.Error.WriteLine("[ATOL] COM object created");
        return driver;
    }

    private static void QueryStatus(dynamic fptr) {
        Console.Error.WriteLine("[ATOL] query status started");
        fptr.setParam(
            Constant(fptr, "LIBFPTR_PARAM_DATA_TYPE"),
            Constant(fptr, "LIBFPTR_DT_STATUS"));
        Check(fptr.queryData(), fptr);
        Console.Error.WriteLine("[ATOL] query status finished");
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

    public Task<object> InvokeAsync(string command, Func<object> action) {
        var completion = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        queue.Add(new WorkItem(command, action, completion));
        return completion.Task;
    }

    private void Run() {
        Console.Error.WriteLine("[ATOL] STA thread started");
        foreach (var work in queue.GetConsumingEnumerable()) {
            Console.Error.WriteLine($"[ATOL] STA executing {work.Command}");
            try {
                work.Completion.SetResult(work.Action());
                Console.Error.WriteLine($"[ATOL] STA finished {work.Command}");
            } catch (Exception error) {
                Console.Error.WriteLine($"[ATOL] STA failed {work.Command}: {error.Message}");
                work.Completion.SetException(error);
            }
        }
    }

    public void Dispose() {
        queue.CompleteAdding();
        if (!thread.Join(TimeSpan.FromMilliseconds(250))) {
            Console.Error.WriteLine("[ATOL] STA thread did not stop within 250 ms");
        }
        queue.Dispose();
    }

    private sealed record WorkItem(string Command, Func<object> Action, TaskCompletionSource<object> Completion);
}

internal sealed record BridgeRequest(int? ProtocolVersion, string? Id, string Command, JsonElement? Args);

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
        int? driverErrorCode = null, string? driverErrorDescription = null, string? stage = null) =>
        new(BridgeProtocol.Version, id, false, null,
            new BridgeError(code, message, driverErrorCode, driverErrorDescription, stage));
}

internal sealed record BridgeError(
    string Code,
    string Message,
    int? DriverErrorCode,
    string? DriverErrorDescription,
    string? Stage = null
);

internal sealed class ProtocolException(string code, string message) : Exception(message) {
    public string Code { get; } = code;
}

internal sealed class DriverFailure(int? code, string description, string? operationCode = null, string? stage = null) : Exception(description) {
    public int? Code { get; } = code;
    public string Description { get; } = description;
    public string? OperationCode { get; } = operationCode;
    public string? Stage { get; } = stage;
}

internal static class BridgeProtocol {
    public const int Version = 1;
}
