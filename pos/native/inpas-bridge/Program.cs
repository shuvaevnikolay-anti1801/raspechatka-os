using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class Program
{
    private const int ProtocolVersion = 1;

    public static int Main()
    {
        var serializer = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
        using (var dispatcher = new StaDispatcher())
        {
            var session = new InpasSession();
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                IDictionary<string, object> response;
                string requestId = null;
                try
                {
                    var request = serializer.Deserialize<Dictionary<string, object>>(line);
                    if (request == null) throw new BridgeException("invalid_request", "Request is empty.");
                    var id = Text(request, "id");
                    requestId = id;
                    if (Number(request, "protocolVersion") != ProtocolVersion)
                        throw new BridgeException("unsupported_protocol", "Expected protocolVersion 1.", id);
                    if (String.IsNullOrWhiteSpace(id))
                        throw new BridgeException("invalid_request", "Request id is required.");
                    var command = Text(request, "command");
                    var args = ObjectMap(request, "args");
                    var result = dispatcher.InvokeAsync(() => session.Execute(command, args))
                        .GetAwaiter().GetResult();
                    response = Success(id, result);
                    Console.Out.WriteLine(serializer.Serialize(response));
                    Console.Out.Flush();
                    if (command == "shutdown") break;
                    continue;
                }
                catch (BridgeException error)
                {
                    response = Failure(error.RequestId ?? requestId, error.Code, error.Message, error.HResult);
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine(error);
                    response = Failure(requestId, "bridge_error", error.Message, error.HResult);
                }
                Console.Out.WriteLine(serializer.Serialize(response));
                Console.Out.Flush();
            }
        }
        return 0;
    }

    private static IDictionary<string, object> Success(string id, object result)
    {
        return new Dictionary<string, object>
        {
            ["protocolVersion"] = ProtocolVersion,
            ["id"] = id,
            ["ok"] = true,
            ["result"] = result,
            ["error"] = null
        };
    }

    private static IDictionary<string, object> Failure(
        string id, string code, string message, int? nativeCode)
    {
        return new Dictionary<string, object>
        {
            ["protocolVersion"] = ProtocolVersion,
            ["id"] = id,
            ["ok"] = false,
            ["result"] = null,
            ["error"] = new Dictionary<string, object>
            {
                ["code"] = code,
                ["message"] = message,
                ["nativeErrorCode"] = nativeCode
            }
        };
    }

    internal static string Text(IDictionary<string, object> source, string key)
    {
        object value;
        return source != null && source.TryGetValue(key, out value) && value != null
            ? Convert.ToString(value, CultureInfo.InvariantCulture)
            : null;
    }

    private static int Number(IDictionary<string, object> source, string key)
    {
        object value;
        return source != null && source.TryGetValue(key, out value) && value != null
            ? Convert.ToInt32(value, CultureInfo.InvariantCulture)
            : 0;
    }

    private static IDictionary<string, object> ObjectMap(
        IDictionary<string, object> source, string key)
    {
        object value;
        if (source == null || !source.TryGetValue(key, out value) || value == null)
            return new Dictionary<string, object>();
        var dictionary = value as IDictionary<string, object>;
        return dictionary ?? new Dictionary<string, object>();
    }
}

internal sealed class InpasSession
{
    private const string LinkProgId = "DualConnector.DCLink";
    private const string PacketProgId = "DualConnector.SAPacket";
    private object link;
    private object packet;

    public object Execute(string command, IDictionary<string, object> args)
    {
        switch (command)
        {
            case "driverInfo": return DriverInfo();
            case "status": return Status();
            case "testConnection": return TestConnection(args);
            case "shutdown": return Shutdown();
            default: throw new BridgeException("unknown_command", "Unsupported command: " + command);
        }
    }

    private object DriverInfo()
    {
        try
        {
            EnsureComObjects();
            return new Dictionary<string, object>
            {
                ["installed"] = true,
                ["architecture"] = "x64",
                ["version"] = SafeText(link, "Version", "DriverVersion", "FileVersion"),
                ["linkProgId"] = LinkProgId,
                ["packetProgId"] = PacketProgId
            };
        }
        catch (DriverMissingException error)
        {
            return new Dictionary<string, object>
            {
                ["installed"] = false,
                ["architecture"] = "x64",
                ["code"] = "driver_missing",
                ["error"] = error.Message
            };
        }
    }

    private object Status()
    {
        EnsureComObjects();
        return new Dictionary<string, object>
        {
            ["installed"] = true,
            ["status"] = "registered",
            ["version"] = SafeText(link, "Version", "DriverVersion", "FileVersion")
        };
    }

    private object TestConnection(IDictionary<string, object> args)
    {
        var terminalId = Program.Text(args, "terminalId");
        if (String.IsNullOrWhiteSpace(terminalId) || !Regex.IsMatch(terminalId, "^\\d{1,32}$"))
            throw new BridgeException("invalid_terminal_id", "A numeric terminalId is required.");

        EnsureComObjects();
        ClearPacket();
        if (!TrySet(packet, "26", "OperationCode", "Operation", "OperationID", "OperationType"))
            throw new BridgeException("unsupported_driver", "SAPacket does not expose an operation field.");
        if (!TrySet(packet, terminalId, "TerminalID", "TerminalId"))
            throw new BridgeException("unsupported_driver", "SAPacket does not expose TerminalID.");

        object exchangeResult;
        try
        {
            exchangeResult = Invoke(link, "Exchange", packet);
        }
        catch (TargetInvocationException error)
        {
            var cause = error.InnerException ?? error;
            throw new BridgeException("driver_error", cause.Message, null, cause.HResult);
        }
        catch (COMException error)
        {
            throw new BridgeException("driver_error", error.Message, null, error.HResult);
        }

        var response = IsPacketLike(exchangeResult) ? exchangeResult : packet;
        var responseCode = SafeText(response,
            "ResponseCode", "HostResponseCode", "ResponseStatus", "ResultCode");
        var transactionStatus = SafeText(response,
            "TransactionStatus", "Status", "ResultStatus");
        var success = IsSuccess(exchangeResult, responseCode, transactionStatus);
        var description = SafeText(response,
            "ResponseDescription", "ErrorDescription", "ResultDescription", "Message");
        var receipt = SanitizeReceipt(SafeText(response, "ReceiptData", "Receipt"));

        return new Dictionary<string, object>
        {
            ["success"] = success,
            ["status"] = success ? "connected" : "error",
            ["terminalId"] = SafeText(response, "TerminalID", "TerminalId") ?? terminalId,
            ["referenceNumber"] = SafeText(response, "ReferenceNumber", "RRN"),
            ["terminalTransactionId"] = SafeText(response,
                "TerminalTransactionID", "TerminalTransactionId", "TransactionID", "TransactionId"),
            ["model"] = SafeText(response, "ModelNo", "Model", "DeviceModel"),
            ["serial"] = SafeText(response, "DeviceSerNumber", "SerialNumber", "DeviceSerialNumber"),
            ["responseCode"] = responseCode,
            ["responseDescription"] = description,
            ["transactionStatus"] = transactionStatus,
            ["receipt"] = receipt
        };
    }

    private object Shutdown()
    {
        ReleaseComObjects();
        return new Dictionary<string, object> { ["stopping"] = true };
    }

    private void EnsureComObjects()
    {
        if (link != null && packet != null) return;
        var linkType = Type.GetTypeFromProgID(LinkProgId, false);
        var packetType = Type.GetTypeFromProgID(PacketProgId, false);
        if (linkType == null || packetType == null)
            throw new DriverMissingException(
                "INPAS DualConnector COM classes are not registered for x64. " +
                "Repair the bank Integrator installation.");
        try
        {
            link = Activator.CreateInstance(linkType);
            packet = Activator.CreateInstance(packetType);
        }
        catch (Exception error)
        {
            ReleaseComObjects();
            throw new DriverMissingException(
                "INPAS DualConnector COM activation failed: " + error.Message, error);
        }
    }

    private void ClearPacket()
    {
        if (packet != null && Marshal.IsComObject(packet))
            Marshal.FinalReleaseComObject(packet);
        packet = null;
        var packetType = Type.GetTypeFromProgID(PacketProgId, false);
        if (packetType == null)
            throw new DriverMissingException("DualConnector.SAPacket is not registered for x64.");
        packet = Activator.CreateInstance(packetType);
    }

    private void ReleaseComObjects()
    {
        if (packet != null && Marshal.IsComObject(packet))
            Marshal.FinalReleaseComObject(packet);
        if (link != null && Marshal.IsComObject(link))
            Marshal.FinalReleaseComObject(link);
        packet = null;
        link = null;
    }

    private static bool IsPacketLike(object value)
    {
        return value != null && !(value is bool) && !(value is string) &&
            !(value.GetType().IsPrimitive);
    }

    private static bool IsSuccess(object exchangeResult, string responseCode, string status)
    {
        if (exchangeResult is bool && (bool)exchangeResult) return true;
        var code = (responseCode ?? "").Trim();
        if (code == "0" || code == "00" || code == "1") return true;
        var normalized = (status ?? "").Trim().ToUpperInvariant();
        return normalized == "1" || normalized == "OK" ||
            normalized.Contains("APPROVED") || normalized.Contains("SUCCESS");
    }

    private static object Invoke(object target, string name, params object[] args)
    {
        return target.GetType().InvokeMember(name,
            BindingFlags.InvokeMethod | BindingFlags.Public | BindingFlags.Instance,
            null, target, args, CultureInfo.InvariantCulture);
    }

    private static bool TrySet(object target, object value, params string[] names)
    {
        foreach (var name in names)
        {
            try
            {
                target.GetType().InvokeMember(name,
                    BindingFlags.SetProperty | BindingFlags.Public | BindingFlags.Instance,
                    null, target, new[] { value }, CultureInfo.InvariantCulture);
                return true;
            }
            catch { }
        }
        return false;
    }

    private static string SafeText(object target, params string[] names)
    {
        if (target == null) return null;
        foreach (var name in names)
        {
            try
            {
                var value = target.GetType().InvokeMember(name,
                    BindingFlags.GetProperty | BindingFlags.Public | BindingFlags.Instance,
                    null, target, null, CultureInfo.InvariantCulture);
                if (value != null) return Convert.ToString(value, CultureInfo.InvariantCulture);
            }
            catch { }
        }
        return null;
    }

    private static string SanitizeReceipt(string receipt)
    {
        if (String.IsNullOrWhiteSpace(receipt)) return null;
        var safeLines = new List<string>();
        foreach (var line in receipt.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None))
        {
            if (Regex.IsMatch(line, "(PAN|TRACK|PIN|CARDHOLDER|НОМЕР\\s+КАРТ|МАГНИТ)", RegexOptions.IgnoreCase))
                continue;
            safeLines.Add(Regex.Replace(line, "(?<!\\d)\\d{12,19}(?!\\d)", "[REDACTED]"));
        }
        var safe = String.Join(Environment.NewLine, safeLines).Trim();
        return safe.Length > 4000 ? safe.Substring(0, 4000) : safe;
    }
}

internal sealed class StaDispatcher : IDisposable
{
    private readonly BlockingCollection<WorkItem> queue = new BlockingCollection<WorkItem>();
    private readonly Thread thread;

    public StaDispatcher()
    {
        thread = new Thread(Run) { IsBackground = true, Name = "INPAS DualConnector STA" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    public Task<object> InvokeAsync(Func<object> action)
    {
        var completion = new TaskCompletionSource<object>();
        queue.Add(new WorkItem(action, completion));
        return completion.Task;
    }

    private void Run()
    {
        foreach (var item in queue.GetConsumingEnumerable())
        {
            try { item.Completion.SetResult(item.Action()); }
            catch (Exception error) { item.Completion.SetException(error); }
        }
    }

    public void Dispose()
    {
        queue.CompleteAdding();
        thread.Join();
        queue.Dispose();
    }

    private sealed class WorkItem
    {
        public readonly Func<object> Action;
        public readonly TaskCompletionSource<object> Completion;
        public WorkItem(Func<object> action, TaskCompletionSource<object> completion)
        {
            Action = action;
            Completion = completion;
        }
    }
}

internal class BridgeException : Exception
{
    public readonly string Code;
    public readonly string RequestId;
    public BridgeException(string code, string message, string requestId = null, int? hresult = null)
        : base(message)
    {
        Code = code;
        RequestId = requestId;
        if (hresult.HasValue) HResult = hresult.Value;
    }
}

internal sealed class DriverMissingException : BridgeException
{
    public DriverMissingException(string message, Exception inner = null)
        : base("driver_missing", message, null, inner == null ? (int?)null : inner.HResult) { }
}
