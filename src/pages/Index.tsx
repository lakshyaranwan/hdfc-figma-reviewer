import { useState } from "react";
import { Card } from "@/components/ui/card";
import { AnalysisForm } from "@/components/AnalysisForm";
import { FeedbackDisplay } from "@/components/FeedbackDisplay";
import hdfcLogo from "@/assets/hdfc-logo.png";

export type FeedbackItem = {
  id: string;
  category: "ux" | "ui" | "consistency" | "improvement";
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
  location?: string;
};

const Index = () => {
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [fileKey, setFileKey] = useState<string>("");

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-gradient-to-br from-primary to-primary/80">
              <img src={hdfcLogo} alt="HDFC Logo" className="w-6 h-6 object-contain" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Figma AI Analyzer</h1>
              <p className="text-sm text-muted-foreground">Get intelligent UX/UI feedback powered by AI</p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-6 py-8 max-w-7xl">
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Analysis Form */}
          <div className="lg:sticky lg:top-24 h-fit">
            <Card className="p-6 shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-hover)] transition-shadow duration-200">
              <AnalysisForm 
                onAnalysisComplete={setFeedback}
                isAnalyzing={isAnalyzing}
                setIsAnalyzing={setIsAnalyzing}
                onFileKeyExtracted={setFileKey}
              />
            </Card>
          </div>

          {/* Feedback Display */}
          <div>
            <FeedbackDisplay 
              feedback={feedback}
              isAnalyzing={isAnalyzing}
              fileKey={fileKey}
            />
          </div>
        </div>
      </main>
    </div>
  );
};

export default Index;
