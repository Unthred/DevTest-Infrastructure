var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
public partial class Program { }
