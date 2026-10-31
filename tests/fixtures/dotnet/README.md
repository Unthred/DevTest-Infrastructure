# .NET test fixture (issue #4)

Minimal API (`Api`), Razor component library (`Blazor`) and xUnit projects. `Tests` passes; `FailingTests` contains one deliberate failure for the subject-failed path. Set `FixtureTfm` (net8.0, net9.0 or net10.0) via the project's `Directory.Build.props` default of `net8.0`; `dev-test dotnet test --sdk <n>` selects the SDK image. Packages (xunit, coverlet.collector, Microsoft.NET.Test.Sdk) must be present in the offline NuGet cache for the SDK first; see `docs/dotnet-testing.md`.
