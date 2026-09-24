using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class Program
{
    private const int ProtocolVersion = 1;

    public static int Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
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
                    requestId = Text(request, "id");
                    if (Number(request, "protocolVersion") != ProtocolVersion)
                        throw new BridgeException("unsupported_protocol", "Expected protocolVersion 1.", requestId);
                    if (String.IsNullOrWhiteSpace(requestId))
                        throw new BridgeException("invalid_request", "Request id is required.");
                    var command = Text(request, "command");
                    var args = ObjectMap(request, "args");
                    var result = dispatcher.InvokeAsync(() => session.Execute(command, args))
                        .GetAwaiter().GetResult();
                    response = Success(requestId, result);
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

    internal static long Long(IDictionary<string, object> source, string key)
    {
        object value;
        long result;
        if (source == null || !source.TryGetValue(key, out value) || value == null ||
            !Int64.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture),
                NumberStyles.Integer, CultureInfo.InvariantCulture, out result))
            throw new BridgeException("invalid_request", key + " must be an integer.");
        return result;
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
    private dynamic link;
    private dynamic packet;

    public object Execute(string command, IDictionary<string, object> args)
    {
        switch (command)
        {
            case "driverInfo": return DriverInfo();
            case "status": return Status();
            case "testConnection": return TestConnection(args);
            case "sale": return Sale(args);
            case "refund": return Refund(args);
            case "void": return Void(args);
            case "reconcile": return Reconcile(args);
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
        var result = ExecuteOperation(args, 26, "test", false, false);
        var map = (Dictionary<string, object>)result;
        if ((string)map["outcome"] == "unknown" &&
            map["exchangeAccepted"] is bool && (bool)map["exchangeAccepted"])
        {
            map["outcome"] = "approved";
            map["success"] = true;
            map["status"] = "connected";
        }
        return map;
    }

    private object Sale(IDictionary<string, object> args)
    {
        var amountMinor = Program.Long(args, "amountMinor");
        if (amountMinor <= 0)
            throw new BridgeException("invalid_amount", "amountMinor must be a positive integer.");
        var currency = Program.Text(args, "currency");
        if (currency != "643")
            throw new BridgeException("invalid_currency", "Direct INPAS sale requires currency 643.");
        return ExecuteOperation(args, 1, "sale", true, true);
    }

    private object Refund(IDictionary<string, object> args)
    {
        return ExecuteOperation(args, 29, "refund", true, true);
    }

    private object Void(IDictionary<string, object> args)
    {
        return ExecuteOperation(args, 4, "void", true, true);
    }

    private object Reconcile(IDictionary<string, object> args)
    {
        return ExecuteOperation(args, 59, "reconcile", false, false);
    }

    private object ExecuteOperation(
        IDictionary<string, object> args,
        int operationCode,
        string operationKind,
        bool requireAmount,
        bool requireCurrency)
    {
        var terminalId = Program.Text(args, "terminalId");
        if (String.IsNullOrWhiteSpace(terminalId) || !Regex.IsMatch(terminalId, "^\\d{1,32}$"))
            throw new BridgeException("invalid_terminal_id", "A numeric terminalId is required.");

        EnsureComObjects();
        ClearPacket();
        packet.OperationCode = operationCode;
        const int fieldAmount = 0, fieldCurrency = 4, fieldRrn = 14, fieldTerminalId = 27;
        if (!packet.SetField(fieldTerminalId, terminalId))
            throw new BridgeException("unsupported_driver", "SAPacket rejected terminal ID.");
        long? amountMinor = null;
        if (requireAmount)
        {
            amountMinor = Program.Long(args, "amountMinor");
            if (amountMinor.Value <= 0)
                throw new BridgeException("invalid_amount", "amountMinor must be a positive integer.");
            if (!packet.SetFieldInt(fieldAmount, checked((int)amountMinor.Value)))
                throw new BridgeException("unsupported_driver", "SAPacket rejected transaction amount.");
        }
        if (requireCurrency)
        {
            var currency = Program.Text(args, "currency");
            if (currency != "643")
                throw new BridgeException("invalid_currency", "INPAS monetary operations require currency 643.");
            if (!packet.SetField(fieldCurrency, currency))
                throw new BridgeException("unsupported_driver", "SAPacket rejected currency.");
        }
        if (operationKind == "refund" || operationKind == "void")
        {
            var referenceNumber = Program.Text(args, "referenceNumber");
            if (String.IsNullOrWhiteSpace(referenceNumber) || referenceNumber.Length > 200 ||
                Regex.IsMatch(referenceNumber, "[\\r\\n\\0]"))
                throw new BridgeException("missing_original_reference",
                    "ReferenceNumber/RRN from the original operation is required.");
            if (!packet.SetField(fieldRrn, referenceNumber))
                throw new BridgeException("unsupported_driver", "SAPacket rejected original RRN.");
            var originalTransactionId = Program.Text(args, "terminalTransactionId");
            if (Int32.TryParse(originalTransactionId, out var trxId))
                packet.TerminalTrxID = trxId;
        }

        var responsePacket = Activator.CreateInstance(packet.GetType());
        var exchangeArgs = new object[] { packet, responsePacket, 120 };
        int exchangeResult;
        try
        {
            exchangeResult = Convert.ToInt32(Invoke(link, "Exchange", exchangeArgs), CultureInfo.InvariantCulture);
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

        var responseCode = ReadField(responsePacket, 15);
        var transactionStatus = ReadField(responsePacket, 107);
        var outcome = ClassifyOutcome(responseCode, transactionStatus);
        var description = ReadField(responsePacket, 71);

        return new Dictionary<string, object>
        {
            ["success"] = outcome == "approved",
            ["outcome"] = outcome,
            ["status"] = operationKind == "test" && outcome == "approved" ? "connected" : outcome,
            ["operationKind"] = operationKind,
            ["terminalId"] = ReadField(responsePacket, 27) ?? terminalId,
            ["referenceNumber"] = ReadField(responsePacket, 14),
            ["terminalTransactionId"] = SafeText(responsePacket,
                "TerminalTrxID", "TerminalTrxId", "TerminalTransactionID", "TerminalTransactionId",
                "TransactionID", "TransactionId"),
            ["authorizationCode"] = ReadField(responsePacket, 13),
            ["model"] = ReadField(responsePacket, 89),
            ["serial"] = ReadField(responsePacket, 63),
            ["responseCode"] = responseCode,
            ["responseDescription"] = description,
            ["transactionStatus"] = transactionStatus,
            ["amountMinor"] = amountMinor,
            ["receipt"] = SanitizeReceipt(ReadField(responsePacket, 90)),
            ["exchangeAccepted"] = exchangeResult == 0
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

    private static string ClassifyOutcome(string responseCode, string status)
    {
        var code = (responseCode ?? "").Trim().ToUpperInvariant();
        var normalized = (status ?? "").Trim().ToUpperInvariant();
        var codeApproved = code == "0" || code == "00";
        var statusApproved = normalized == "1" || normalized == "OK" ||
            normalized.Contains("APPROVED") || normalized.Contains("SUCCESS") ||
            normalized.Contains("ОДОБР");
        var codeDeclined = code.Length > 0 && !codeApproved;
        var statusDeclined = normalized.Length > 0 && !statusApproved &&
            (normalized.Contains("DECLIN") || normalized.Contains("REJECT") ||
             normalized.Contains("DENIED") || normalized.Contains("ОТКАЗ"));
        var approved = codeApproved || statusApproved;
        var declined = codeDeclined || statusDeclined;
        if (approved && !declined) return "approved";
        if (declined && !approved) return "declined";
        return "unknown";
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
                    BindingFlags.SetProperty | BindingFlags.SetField |
                    BindingFlags.Public | BindingFlags.Instance,
                    null, target, new[] { value }, CultureInfo.InvariantCulture);
                return true;
            }
            catch { }
        }
        return false;
    }

    private static string ReadField(dynamic packetValue, int fieldId)
    {
        try
        {
            var value = packetValue.GetField(fieldId);
            return value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
        }
        catch { return null; }
    }

    private static string SafeText(object target, params string[] names)
    {
        if (target == null) return null;
        foreach (var name in names)
        {
            try
            {
                var value = target.GetType().InvokeMember(name,
                    BindingFlags.GetProperty | BindingFlags.GetField |
                    BindingFlags.Public | BindingFlags.Instance,
                    null, target, null, CultureInfo.InvariantCulture);
                if (value != null)
                {
                    var text = Convert.ToString(value, CultureInfo.InvariantCulture);
                    if (!String.IsNullOrWhiteSpace(text))
                        return text.Trim().Length > 500 ? text.Trim().Substring(0, 500) : text.Trim();
                }
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
            if (Regex.IsMatch(line, "(PAN|TRACK|PIN|CARD|КАРТ|МАГНИТ)", RegexOptions.IgnoreCase))
                continue;
            var safeLine = Regex.Replace(line, "(?<!\\d)\\d{12,19}(?!\\d)", "[REDACTED]");
            safeLine = Regex.Replace(safeLine, "(?:\\*|X){4,}\\d{4}", "[REDACTED]", RegexOptions.IgnoreCase);
            safeLines.Add(safeLine);
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
